// A local stand-in for an OpenTimestamps calendar, for the seal E2E (started by playwright.config.ts).
// The API test server is pointed at it through OTS_CALENDAR_URLS, so no test reaches a real calendar.
//
//   POST /digest           → sha256 → "pending at <this calendar>", like a real calendar's reply
//                            (which names its own URL, so the server's upgrade asks it back)
//   GET  /timestamp/<hex>  → 404 "pending" until POST /__confirm, then a completed timestamp in a
//                            real calendar's shape: the message wrapped into a "transaction"
//                            (prepend version + OP_RETURN PUSH32, append the rest) → sha256 →
//                            sha256 (the txid) → Bitcoin block 900123; valid for any message
//   POST /__pending        → back to pending (the spec's own reset)

const FAKE_OTS_CALENDAR_PORT = Number(process.env.FAKE_OTS_CALENDAR_PORT ?? 3998);
const SELF_URL = new TextEncoder().encode(`http://127.0.0.1:${FAKE_OTS_CALENDAR_PORT}`);

// 0x08 sha256, 0x00 attestation, the pending tag, then varbytes(varbytes(uri)) — both lengths < 128.
const PENDING = new Uint8Array([
    0x08,
    0x00,
    0x83,
    0xdf,
    0xe3,
    0x0d,
    0x2e,
    0xf9,
    0x0c,
    0x8e,
    SELF_URL.length + 1,
    SELF_URL.length,
    ...SELF_URL,
]);
// The bytes a calendar puts around its Merkle tip: version 2 and OP_RETURN PUSH32 before it, 40
// bytes of "the rest of the transaction" after it (enough for the client to see > 64 bytes).
const TX_PREFIX = [0x02, 0x00, 0x00, 0x00, 0x6a, 0x20];
const TX_SUFFIX = new Array<number>(40).fill(0x11);
// prepend(prefix) → append(suffix) → sha256 → sha256 → Bitcoin attestation; 900123 as a LEB128
// varuint is 9b f8 36.
const CONFIRMED = new Uint8Array([
    0xf1,
    TX_PREFIX.length,
    ...TX_PREFIX,
    0xf0,
    TX_SUFFIX.length,
    ...TX_SUFFIX,
    0x08,
    0x08,
    0x00,
    0x05,
    0x88,
    0x96,
    0x0d,
    0x73,
    0xd7,
    0x19,
    0x01,
    0x03,
    0x9b,
    0xf8,
    0x36,
]);

let confirmed = false;

if (import.meta.main) {
    Bun.serve({
        port: FAKE_OTS_CALENDAR_PORT,
        hostname: "127.0.0.1",
        fetch(req) {
            const { pathname } = new URL(req.url);
            if (req.method === "GET" && pathname === "/health") return new Response("ok");
            if (req.method === "POST" && pathname === "/__confirm") {
                confirmed = true;
                return new Response("ok");
            }
            if (req.method === "POST" && pathname === "/__pending") {
                confirmed = false;
                return new Response("ok");
            }
            if (req.method === "POST" && pathname === "/digest") return new Response(PENDING);
            if (req.method === "GET" && pathname.startsWith("/timestamp/")) {
                return confirmed
                    ? new Response(CONFIRMED)
                    : new Response("Pending confirmation in Bitcoin blockchain", { status: 404 });
            }
            return new Response("not found", { status: 404 });
        },
    });
}
