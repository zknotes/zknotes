/**
 * The human-readable certificate, built entirely in the browser: the server never sees the file
 * name, the hash or the manifest, so it could not make this document even if asked to.
 *
 * jsPDF is loaded only here, on demand, so it never reaches the main bundle.
 */
import { txUrl } from "./explorer";
import { existedBefore, type SealView } from "./seal-service";

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
    const before = view.state === "confirmed" ? existedBefore(view.record) : null;
    if (!before) throw new Error("A pending seal has no certificate yet.");
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const left = 56;
    const top = 72;
    const width = doc.internal.pageSize.getWidth() - left * 2;
    const bottom = doc.internal.pageSize.getHeight() - 56;
    let y = top;

    /** Starts a new page when the next `height` points would run past the bottom margin. */
    const room = (height: number) => {
        if (y + height > bottom) {
            doc.addPage();
            y = top;
        }
    };
    const line = (
        text: string,
        opts: { size?: number; bold?: boolean; mono?: boolean; gap?: number } = {},
    ) => {
        doc.setFont(opts.mono ? "courier" : "helvetica", opts.bold ? "bold" : "normal");
        doc.setFontSize(opts.size ?? 10);
        const lines = doc.splitTextToSize(latin1(text), width) as string[];
        const height = lines.length * (opts.size ?? 10) * 1.35;
        room(height);
        doc.text(lines, left, y);
        y += height + (opts.gap ?? 4);
    };
    /** One clickable line; a URL is ASCII and short enough for one line at this size. */
    const link = (text: string, url: string, size = 8) => {
        doc.setFont("courier", "normal");
        doc.setFontSize(size);
        room(size * 1.35);
        doc.textWithLink(text, left, y, { url });
        y += size * 1.35 + 2;
    };
    /** A heading kept on the same page as the first `keep` points of what follows it. */
    const heading = (text: string, size: number, keep: number) => {
        room(size * 1.35 + keep);
        line(text, { size, bold: true, gap: 6 });
    };
    const field = (label: string, value: string, mono = false) => {
        line(label, { size: 8, bold: true, gap: 1 });
        line(value, { size: 10, mono, gap: 8 });
    };

    line("ZKnotes", { size: 9, bold: true, gap: 2 });
    line("Certificate of Existence", { size: 20, bold: true, gap: 14 });
    line(
        `The file described below existed, exactly as fingerprinted here, before ${utcText(before.iso)}.`,
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
        before.source === "block"
            ? `Existed before (the time recorded in block ${before.height.toLocaleString("en-US")}, set by its miner)`
            : "Existed before (when the sealing device first saw the proof completed)",
        utcText(before.iso),
    );
    field(
        "Anchored in public ledger block",
        view.blocks.map((b) => b.toLocaleString("en-US")).join(", "),
    );
    if (before.source === "block") {
        line(
            "A block's time is set by the miner who found it; the network's rules keep it within about two hours of real time.",
            { size: 8, gap: 8 },
        );
    }
    if (view.anchors.length > 0) {
        y += 2;
        heading("Where the proof is recorded", 11, 70);
        line(
            "Each anchor is a transaction a timestamp calendar wrote to the public ledger. Its OP_RETURN output holds a value computed from manifest.json along the proof's path, not the file's fingerprint, which is never published. Any block explorer shows it by its id; each id below links to mempool.space.",
            { size: 8, gap: 5 },
        );
        for (const a of view.anchors) {
            link(`Block ${a.height.toLocaleString("en-US")}  tx ${a.txid}`, txUrl(a.txid));
            line(`OP_RETURN ${a.opReturn}`, { size: 8, mono: true, gap: 4 });
        }
    }
    y += 6;
    heading("How to check this certificate", 12, 60);
    line(
        "The archive this certificate came with holds manifest.json, manifest.json.ots and VERIFY.txt. VERIFY.txt lists the three steps, using only free, standard tools. No account with ZKnotes and no ZKnotes server is needed. The file's SHA-256 must equal content_sha256 in manifest.json, and the OpenTimestamps proof manifest.json.ots must verify against manifest.json.",
        { gap: 16 },
    );

    // The notice is kept whole: it either fits under the rest or starts the next page.
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const noticeHeight = LEGAL_NOTICE.reduce(
        (sum, p) => sum + (doc.splitTextToSize(latin1(p), width) as string[]).length * 9 * 1.35 + 5,
        0,
    );
    heading(LEGAL_NOTICE_TITLE, 11, noticeHeight);
    for (const p of LEGAL_NOTICE) line(p, { size: 9, gap: 5 });

    return new Uint8Array(doc.output("arraybuffer"));
}
