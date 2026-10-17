import type { FastifyReply, FastifyRequest } from "fastify";

const includeValidationDetails = () => process.env.NODE_ENV !== "production";

export function validationErrorPayload(
    error: { issues: unknown[] },
    message = "Invalid input",
): { error: string; details?: unknown[] } {
    return includeValidationDetails()
        ? { error: message, details: error.issues }
        : { error: message };
}

export function parseBody<T>(
    schema: {
        safeParse: (
            data: unknown,
        ) => { success: true; data: T } | { success: false; error: { issues: unknown[] } };
    },
    request: FastifyRequest,
    reply: FastifyReply,
): T | null {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
        reply.status(400).send(validationErrorPayload(parsed.error));
        return null;
    }
    return parsed.data;
}
