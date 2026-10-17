// The pino log levels — one place of truth, shared by the API (validating /dev-log-level and the
// logger config) and the web client (the dropdown in the DevPanel).

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}
