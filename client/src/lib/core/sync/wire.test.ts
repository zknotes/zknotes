import { describe, expect, it } from "vitest";
import type { LocalItem } from "$lib/core/db";
import { toWireFormat } from "./wire";

describe("toWireFormat", () => {
    // A conflict copy's link to its original travels inside the ciphertext, so the server cannot tell
    // which item copies which; a push error is the client's own bookkeeping. Neither belongs on the
    // wire — the server drops unknown keys, but a logging proxy or a future route would not.
    it("drops every client-only field", () => {
        const local = {
            id: "0190f6a0-0000-7000-8000-000000000001",
            type: "note",
            parent_id: null,
            encrypted_payload: "cGF5bG9hZA==",
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
            sort_order: "m",
            version: 2,
            dirty: true,
            localRev: 7,
            conflict_of: "0190f6a0-0000-7000-8000-000000000002",
            sync_error: "Parent not found",
        } as LocalItem;

        const sent = JSON.parse(JSON.stringify(toWireFormat(local))) as Record<string, unknown>;

        for (const key of ["dirty", "localRev", "conflict_of", "sync_error"]) {
            expect(sent).not.toHaveProperty(key);
        }
        expect(sent.id).toBe(local.id);
        expect(sent.version).toBe(2);
    });
});
