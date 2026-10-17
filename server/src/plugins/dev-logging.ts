// DEV-only logging infrastructure — the SSE broadcast to the frontend DevPanel, the stdout/stderr
// hook (debug.log), the /client-log endpoint and the runtime log-level switch.
// Registered ONLY when NODE_ENV !== "production" (see app.ts).
//
// NOTE: /client-error is deliberately NOT here — the client calls it in production too (error
// reporting from the file preview), so it lives in app.ts.
import type { FastifyInstance } from "fastify";
import { type DevLogRecord, devLogEvents, isLogLevel, LOG_LEVELS } from "../logger";

export async function devLogging(fastify: FastifyInstance): Promise<void> {
    const sseClients = new Set<NodeJS.WritableStream>();

    // The SSE endpoint that broadcasts logs to the frontend DevPanel
    fastify.get("/dev-logs-stream", (request, reply) => {
        reply.hijack();
        const origin = request.headers.origin || "*";
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": origin,
        });
        reply.raw.write(": connected\n\n");
        sseClients.add(reply.raw);
        request.raw.on("close", () => sseClients.delete(reply.raw));
    });

    const broadcast = (level: string, message: string, timestamp: number) => {
        const msg = JSON.stringify({ source: "server", level, message, timestamp });
        for (const client of sseClients) {
            client.write(`data: ${msg}\n\n`);
        }
    };

    // Pino records arrive parsed from logger.ts with the exact level — no sniffing of the text.
    const onPinoLog = (rec: DevLogRecord) => broadcast(rec.level, rec.message, rec.timestamp);
    devLogEvents.on("log", onPinoLog);
    fastify.addHook("onClose", (_instance, done) => {
        devLogEvents.off("log", onPinoLog);
        done();
    });

    // stdout/stderr hook: everything into debug.log. Pino output goes to stdout and was already broadcast above;
    // stderr (non-pino output, a Bun crash trace for instance) is broadcast as an error.
    const fs = require("node:fs");
    const LOG_FILE_PATH = process.env.DEV_LOG_FILE || "debug.log";
    const logFile = fs.createWriteStream(LOG_FILE_PATH, { flags: "a" });
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);

    // A regex that strips ANSI escape codes so PhpStorm can parse the output cleanly
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1B) is deliberate — the ANSI escape prefix
    const stripAnsi = (str: string) => str.replace(/\x1B\[\d+;?\d*m/g, "");

    const captureOutput = (chunk: string, isErr: boolean) => {
        const cleanStr = stripAnsi(chunk.toString());
        logFile.write(cleanStr);

        if (!isErr) return;
        const str = cleanStr.trim();
        if (!str) return;
        broadcast("error", str, Date.now());
    };

    type WriteCallback = (err?: Error | null) => void;
    const hookStdout: typeof process.stdout.write = (chunk, encoding?, callback?) => {
        captureOutput(chunk.toString(), false);
        if (typeof encoding === "function") {
            return originalWrite(chunk, encoding);
        }
        return originalWrite(chunk, encoding, callback as WriteCallback | undefined);
    };
    const hookStderr: typeof process.stderr.write = (chunk, encoding?, callback?) => {
        captureOutput(chunk.toString(), true);
        if (typeof encoding === "function") {
            return originalErrWrite(chunk, encoding);
        }
        return originalErrWrite(chunk, encoding, callback as WriteCallback | undefined);
    };
    process.stdout.write = hookStdout;
    process.stderr.write = hookStderr;

    // Changing the log level at runtime, without a restart — warn → debug while hunting a bug, say.
    // Per-request child loggers inherit the level when they are created, so it applies from the next
    // request on.
    fastify.get("/dev-log-level", async () => ({ level: fastify.log.level }));

    fastify.put("/dev-log-level", async (request, reply) => {
        const body = request.body as { level?: string };
        if (typeof body?.level !== "string" || !isLogLevel(body.level)) {
            return reply
                .status(400)
                .send({ error: `level must be one of: ${LOG_LEVELS.join(", ")}` });
        }
        fastify.log.level = body.level;
        fastify.log.info(`Log level changed to "${body.level}"`);
        return reply.send({ level: fastify.log.level });
    });

    // Clear from the DevPanel wipes the server log file too. The stream is open with flags "a"
    // (O_APPEND), so after a truncate new records simply start again from the top of the file.
    fastify.delete("/dev-logs", async (_request, reply) => {
        try {
            await fs.promises.truncate(LOG_FILE_PATH, 0);
        } catch (err) {
            fastify.log.warn({ err }, `Failed to truncate ${LOG_FILE_PATH}`);
            return reply.status(500).send({ success: false });
        }
        return reply.send({ success: true });
    });

    // An endpoint for the frontend to stream general debug logs into the backend console
    fastify.post("/client-log", async (request, reply) => {
        const body = request.body as { level: string; tag: string; args: unknown[] };
        const msg = `[Client ${body.level.toUpperCase()}] [${body.tag}] ${body.args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;

        if (body.level === "error") fastify.log.error(msg);
        else if (body.level === "warn") fastify.log.warn(msg);
        else fastify.log.info(msg);

        return reply.send({ success: true });
    });
}
