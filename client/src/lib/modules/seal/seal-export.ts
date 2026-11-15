/**
 * The certificate archive: everything a third party needs to check the seal without ZKnotes.
 *
 *   <original file>      the sealed bytes (optional, on by default)
 *   manifest.json        what the proof is over: the file's SHA-256, size and type
 *   manifest.json.ots    the OpenTimestamps proof of manifest.json
 *   certificate.pdf      the human-readable certificate with the legal notice
 *   VERIFY.txt           three steps with standard tools
 *
 * Only a confirmed seal can be exported: a pending proof is not evidence yet.
 */
import { getDB } from "$lib/core/db";
import { loadChunk } from "$lib/core/files/chunk-loader";
import { fromBase64 } from "$lib/core/utils/base64";
import { blobDownloadSink, type ByteSink, openFilePickerSink } from "$lib/core/utils/download-sink";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { ZipStreamWriter } from "$lib/core/utils/zip-stream";
import { decryptChunkTask } from "$lib/core/workers/crypto-rpc";
import type { FilePayload } from "@zknotes/shared";
import { txUrl } from "./explorer";
import { buildCertificatePdf, LEGAL_NOTICE, LEGAL_NOTICE_TITLE } from "./seal-pdf";
import type { SealView } from "./seal-service";

export class SealExportCancelled extends Error {
    constructor() {
        super("Export cancelled");
        this.name = "SealExportCancelled";
    }
}

const FIXED_NAMES = new Set([
    "manifest.json",
    "manifest.json.ots",
    "certificate.pdf",
    "verify.txt",
]);

/** A safe single path segment for the original file, never colliding with the fixed entries. */
export function archiveFileName(name: string): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|\p{Cc}]/gu, "_")
        .replace(/^\.+/, "")
        .trim()
        .slice(0, 200);
    const base = cleaned || "file";
    return FIXED_NAMES.has(base.toLowerCase()) ? `file-${base}` : base;
}

export function verifyText(view: SealView, fileEntry: string | null): string {
    const m = view.manifest;
    const file = fileEntry ?? "<the original file>";
    return [
        "HOW TO VERIFY THIS SEAL",
        "=======================",
        "",
        "You need the original file, manifest.json and manifest.json.ots. No ZKnotes account",
        "or server is involved; every step uses free, standard tools.",
        "",
        "1. Fingerprint the file with SHA-256:",
        `     Linux:    sha256sum "${file}"`,
        `     macOS:    shasum -a 256 "${file}"`,
        `     Windows:  certutil -hashfile "${file}" SHA256`,
        "",
        "2. Compare the result with content_sha256 in manifest.json. It must be:",
        `     ${m.content_sha256}`,
        `   The file must also be ${m.byte_length} bytes long. If either differs, this seal does`,
        "   not cover this file.",
        "",
        "3. Verify the timestamp proof of manifest.json with the OpenTimestamps client",
        "   (https://opentimestamps.org, or: pip install opentimestamps-client):",
        "     ots verify manifest.json.ots",
        "   The proof is anchored in the Bitcoin blockchain, and 'ots verify' checks it against a",
        "   Bitcoin node (the one configured on this computer, or --bitcoin-node). Without a",
        "   node, run instead:",
        "     ots --no-bitcoin verify manifest.json.ots",
        "   It recomputes the proof from manifest.json and prints, for each anchor, a line",
        '   "check that Bitcoin block N has merkleroot X". Look up block N on any public Bitcoin',
        "   block explorer: its Merkle root must be exactly X.",
        `   Block height(s): ${view.blocks.join(", ")}`,
        ...anchorLines(view),
        "",
        "If all three steps succeed, a file with exactly these bytes existed before the time of",
        "the earliest of those blocks, which any block explorer shows (a block's time is set by its",
        "miner; the network keeps it within about two hours of real time).",
        "",
        LEGAL_NOTICE_TITLE,
        "-".repeat(LEGAL_NOTICE_TITLE.length),
        ...LEGAL_NOTICE.map((p) => wrap(p, 78)),
        "",
    ].join("\n");
}

/**
 * The public record behind each anchor, as an optional look. It adds nothing to the proof: step 3
 * already checks the whole path, and the explorer is only a signpost to where the path ends.
 */
function anchorLines(view: SealView): string[] {
    if (view.anchors.length === 0) return [];
    const lines = [
        "",
        "   To see where the proof is recorded: each anchor is a Bitcoin transaction made by a",
        "   timestamp calendar. Its OP_RETURN output holds the 32-byte value shown below. That",
        "   value is computed from manifest.json along the proof's path ('ots info",
        "   manifest.json.ots' prints the whole path). It is NOT the file's fingerprint, which",
        "   is never published; one transaction covers many seals at once. Any block explorer",
        "   shows the same transaction for the same id; links:",
    ];
    for (const a of view.anchors) {
        lines.push(
            `     Block ${a.height}, transaction ${a.txid}`,
            `       ${txUrl(a.txid)}`,
            `       OP_RETURN: ${a.opReturn}`,
        );
    }
    return lines;
}

function wrap(text: string, width: number): string {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line && line.length + 1 + word.length > width) {
            out.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) out.push(line);
    return out.join("\n");
}

/** The file item still holding exactly the sealed bytes, or null when its content has moved on. */
export async function sealedFileStillPresent(
    itemId: string,
    view: SealView,
): Promise<FilePayload | null> {
    const db = await getDB();
    const item = await db.get("items", itemId);
    if (!item || FileLifecycle.stateOf(item) !== "READY") return null;
    const { decryptItemPayload } = await import("$lib/core/crypto/item-codec");
    const payload = await decryptItemPayload<FilePayload>(item);
    return payload.kind === "file" && payload.chunkSetId === view.record.chunk_set_id
        ? payload
        : null;
}

async function* plaintextChunks(itemId: string, payload: FilePayload): AsyncGenerator<Uint8Array> {
    const total = payload.chunks.length;
    for (let i = 0; i < total; i++) {
        const ref = payload.chunks[i] as (typeof payload.chunks)[number];
        const nonce = fromBase64(ref.nonce);
        const ciphertext = await loadChunk(payload.chunkSetId, i, nonce, ref.hash, {
            persist: false,
        });
        yield await decryptChunkTask(itemId, payload.chunkSetId, i, total, ciphertext, nonce);
    }
}

async function openSink(filename: string): Promise<ByteSink> {
    const picker = await openFilePickerSink(filename, {
        accept: { "application/zip": [".zip"] },
        onAbort: () => new SealExportCancelled(),
    });
    return picker ?? blobDownloadSink(filename, "application/zip");
}

/** Writes the certificate archive into `sink` (the caller owns opening and closing it). */
export async function writeCertificateArchive(
    sink: ByteSink,
    view: SealView,
    original: { itemId: string; payload: FilePayload } | null,
): Promise<void> {
    if (view.state !== "confirmed") throw new Error("A pending seal cannot be exported yet.");
    const zip = new ZipStreamWriter(sink);
    const enc = new TextEncoder();
    let fileEntry: string | null = null;
    if (original) {
        fileEntry = archiveFileName(view.record.file_name);
        await zip.addStream(fileEntry, plaintextChunks(original.itemId, original.payload), false);
    }
    await zip.addFile("manifest.json", enc.encode(view.record.manifest), false);
    await zip.addFile("manifest.json.ots", fromBase64(view.record.proof), false);
    await zip.addFile("certificate.pdf", await buildCertificatePdf(view), false);
    await zip.addFile("VERIFY.txt", enc.encode(verifyText(view, fileEntry)), true);
    await zip.finish();
}

/** Asks where to save, then streams the archive there. */
export async function exportCertificate(
    view: SealView,
    opts: { itemId: string; includeFile: boolean },
): Promise<void> {
    if (view.state !== "confirmed") throw new Error("A pending seal cannot be exported yet.");
    const payload = opts.includeFile ? await sealedFileStillPresent(opts.itemId, view) : null;
    if (opts.includeFile && !payload) {
        throw new Error("The sealed content is no longer this file's content; export without it.");
    }
    const stem = archiveFileName(view.record.file_name).replace(/\.[^.]*$/, "") || "file";
    const sink = await openSink(`${stem} - certificate of existence.zip`);
    try {
        await writeCertificateArchive(
            sink,
            view,
            payload ? { itemId: opts.itemId, payload } : null,
        );
        await sink.close();
    } catch (e) {
        await sink.abort(e).catch(() => {});
        throw e;
    }
}
