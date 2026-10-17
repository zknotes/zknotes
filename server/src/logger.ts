// The central logger configuration — one source of truth for the log level and the transport.
// Dev:  pino-pretty on stdout plus the devLogEvents emitter (parsed records with the exact level,
//       which dev-logging.ts broadcasts over SSE to the DevPanel).
// Prod: structured JSON on stdout, with sensitive headers redacted (the session cookie!).
// The level comes from LOG_LEVEL in .env; in dev it changes at runtime through PUT /dev-log-level.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "@zknotes/shared";

export { isLogLevel, LOG_LEVELS, type LogLevel };

export const isDev = process.env.NODE_ENV !== "production";

function resolveInitialLevel(): LogLevel {
    const env = process.env.LOG_LEVEL;
    // Dev default "info" — the per-request hook in app.ts writes at debug; otherwise it floods the terminal with noise.
    if (env === undefined || env === "") return "info";
    if (!isLogLevel(env)) {
        throw new Error(`Invalid LOG_LEVEL "${env}" — must be one of: ${LOG_LEVELS.join(", ")}`);
    }
    return env;
}

export const initialLogLevel: LogLevel = resolveInitialLevel();

export interface DevLogRecord {
    level: LogLevel;
    message: string;
    timestamp: number;
}

// Dev only: every pino record is emitted here ("log", DevLogRecord) before it is pretty-printed.
export const devLogEvents = new EventEmitter();

const PINO_LEVEL_LABELS: Record<number, LogLevel> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
};

// The same fields pretty ignores — we do not repeat them in the SSE message.
const IGNORED_KEYS = new Set(["level", "time", "msg", "pid", "hostname", "reqId", "req", "res"]);

function formatDevMessage(rec: Record<string, unknown>): string {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
        if (!IGNORED_KEYS.has(key)) extras[key] = value;
    }
    const msg = typeof rec.msg === "string" ? rec.msg : "";
    const extraStr = Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : "";
    return `${msg}${extraStr}`.trim() || JSON.stringify(rec);
}

export function buildLoggerOptions(): object {
    if (!isDev) {
        return {
            level: initialLogLevel,
            redact: [
                "req.headers.cookie",
                "req.headers.authorization",
                'res.headers["set-cookie"]',
            ],
        };
    }

    // Bun has trouble with Pino worker threads, so we use a synchronous stream
    const pretty = require("pino-pretty");
    const customStream = new PassThrough();
    customStream.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk); // the dev-logging.ts stdout hook catches this for debug.log
    });

    const prettyStream = pretty({
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname,reqId,req,res,responseTime",
        singleLine: true,
        destination: customStream,
    });

    // Intercept the raw pino JSON lines: emit with the exact level for SSE, then pass them on to pretty.
    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            for (const line of chunk.toString().split("\n")) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line) as Record<string, unknown>;
                    devLogEvents.emit("log", {
                        level: PINO_LEVEL_LABELS[rec.level as number] ?? "info",
                        message: formatDevMessage(rec),
                        timestamp: typeof rec.time === "number" ? rec.time : Date.now(),
                    } satisfies DevLogRecord);
                } catch {
                    // not a pino JSON line — pretty will print it anyway
                }
            }
            prettyStream.write(chunk);
            callback();
        },
    });

    return { level: initialLogLevel, stream };
}
