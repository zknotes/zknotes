/**
 * The human-readable certificate, built entirely in the browser: the server never sees the file
 * name, the hash or the manifest, so it could not make this document even if asked to.
 *
 * jsPDF is loaded only here, on demand, so it never reaches the main bundle.
 */
import type { SealView } from "./seal-service";

/** The standard PDF fonts cover Latin-1 only; anything else would print as garbage. */
function latin1(text: string): string {
    return text.replace(/[^ -~ -ÿ]/g, "?");
}

function utcText(iso: string): string {
    return `${iso.replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

export const LEGAL_NOTICE_TITLE = "Important legal notice regarding evidentiary value";
export const LEGAL_NOTICE = [
    "This Certificate of Existence (Proof of Existence) mathematically proves exactly one fact: that a file with the stated cryptographic fingerprint existed before the stated timestamp.",
    "This certificate does NOT prove:",
    "1. Authorship - it does not prove that the person in possession of the file is its author or lawful owner.",
    "2. Truthfulness - it does not prove that any claims or data within the file are accurate, valid, or true.",
    "3. Time of creation - it does not prove when the file was originally created; it establishes only an upper bound (the file certainly existed before this point in time).",
];

export async function buildCertificatePdf(view: SealView): Promise<Uint8Array> {
    if (view.state !== "confirmed" || !view.record.confirmed_at) {
        throw new Error("A pending seal has no certificate yet.");
    }
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const left = 56;
    const width = doc.internal.pageSize.getWidth() - left * 2;
    let y = 72;

    const line = (
        text: string,
        opts: { size?: number; bold?: boolean; mono?: boolean; gap?: number } = {},
    ) => {
        doc.setFont(opts.mono ? "courier" : "helvetica", opts.bold ? "bold" : "normal");
        doc.setFontSize(opts.size ?? 10);
        const lines = doc.splitTextToSize(latin1(text), width) as string[];
        doc.text(lines, left, y);
        y += lines.length * (opts.size ?? 10) * 1.35 + (opts.gap ?? 4);
    };
    const field = (label: string, value: string, mono = false) => {
        line(label, { size: 8, bold: true, gap: 1 });
        line(value, { size: 10, mono, gap: 8 });
    };

    line("ZKnotes", { size: 9, bold: true, gap: 2 });
    line("Certificate of Existence", { size: 20, bold: true, gap: 14 });
    line(
        `The file described below existed, exactly as fingerprinted here, before ${utcText(view.record.confirmed_at)}.`,
        { size: 11, gap: 16 },
    );

    const m = view.manifest;
    field("File", view.record.file_name || "(unnamed)");
    field("SHA-256 fingerprint of the file", m.content_sha256, true);
    field("Size", `${m.byte_length.toLocaleString("en-US")} bytes`);
    field("Declared type", m.content_type);
    field("Seal ID", m.seal_id, true);
    field("Sealed at (as stated by the sealing device)", utcText(m.sealed_at));
    field(
        "Existed before (when this device first saw the proof completed)",
        utcText(view.record.confirmed_at),
    );
    field(
        "Anchored in public ledger block",
        view.blocks.map((b) => b.toLocaleString("en-US")).join(", "),
    );
    y += 6;
    line("How to check this certificate", { size: 12, bold: true, gap: 6 });
    line(
        "The archive this certificate came with holds manifest.json, manifest.json.ots and VERIFY.txt. VERIFY.txt lists the three steps, using only free, standard tools. No account with ZKnotes and no ZKnotes server is needed. The file's SHA-256 must equal content_sha256 in manifest.json, and the OpenTimestamps proof manifest.json.ots must verify against manifest.json.",
        { gap: 16 },
    );

    line(LEGAL_NOTICE_TITLE, { size: 11, bold: true, gap: 6 });
    for (const p of LEGAL_NOTICE) line(p, { size: 9, gap: 6 });

    return new Uint8Array(doc.output("arraybuffer"));
}
