export function clientMeta(request: { ip?: string; headers: Record<string, unknown> }) {
    return {
        ip: request.ip ?? "unknown",
        ua: (request.headers["user-agent"] as string | undefined) ?? null,
    };
}
