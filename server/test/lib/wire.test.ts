import { describe, expect, test } from "bun:test";
import {
    b64ToBuf,
    bufToB64,
    itemToWire,
    requireB64ToBuf,
    snapshotToWire,
    wireBlobsToRow,
    wireBlobsToRowPartial,
} from "../../src/lib/wire";

describe("wire helpers", () => {
    const sample = Buffer.from([1, 2, 3, 255]);

    test("bufToB64 round-trips via b64ToBuf", () => {
        const b64 = bufToB64(sample);
        expect(b64).toBe("AQID/w==");
        expect(b64ToBuf(b64)).toEqual(sample);
    });

    test("bufToB64 returns null for empty input", () => {
        expect(bufToB64(null)).toBeNull();
        expect(bufToB64(undefined)).toBeNull();
    });

    test("b64ToBuf returns null for empty input", () => {
        expect(b64ToBuf(null)).toBeNull();
        expect(b64ToBuf(undefined)).toBeNull();
        expect(b64ToBuf("")).toBeNull();
    });

    test("requireB64ToBuf throws on invalid base64", () => {
        expect(() => requireB64ToBuf("")).toThrow("Invalid base64");
    });

    test("itemToWire strips user_id and encodes blob columns", () => {
        const row = {
            id: "item-1",
            user_id: "user-1",
            encrypted_payload: sample,
            payload_nonce: sample,
            encrypted_item_key: sample,
            item_key_nonce: sample,
            version: 2,
        };
        const wire = itemToWire(row) as Record<string, unknown>;
        expect(wire).not.toHaveProperty("user_id");
        expect(wire.encrypted_payload).toBe("AQID/w==");
        expect(wire.payload_nonce).toBe("AQID/w==");
        expect(wire.encrypted_item_key).toBe("AQID/w==");
        expect(wire.item_key_nonce).toBe("AQID/w==");
        expect(wire.version).toBe(2);
    });

    test("wireBlobsToRow decodes all four blob columns", () => {
        const row = wireBlobsToRow({
            encrypted_payload: "AQID/w==",
            payload_nonce: "AQID/w==",
            encrypted_item_key: "AQID/w==",
            item_key_nonce: "AQID/w==",
        });
        expect(row.encrypted_payload).toEqual(sample);
        expect(row.payload_nonce).toEqual(sample);
        expect(row.encrypted_item_key).toEqual(sample);
        expect(row.item_key_nonce).toEqual(sample);
    });

    test("wireBlobsToRowPartial only decodes provided fields", () => {
        const row = wireBlobsToRowPartial({ encrypted_payload: "AQID/w==" });
        expect(row.encrypted_payload).toEqual(sample);
        expect(row.payload_nonce).toBeUndefined();
    });

    test("snapshotToWire converts blobs and created_at to ms", () => {
        const wire = snapshotToWire({
            id: "snap-1",
            item_id: "note-1",
            encrypted_payload: sample,
            payload_nonce: sample,
            encrypted_item_key: sample,
            item_key_nonce: sample,
            item_version_at_snapshot: 3,
            created_at: 1_700_000_000,
            snapshot_number: 2,
        });
        expect(wire.encrypted_payload).toBe("AQID/w==");
        expect(wire.created_at).toBe(1_700_000_000_000);
        expect(wire.item_version_at_snapshot).toBe(3);
        expect(wire.snapshot_number).toBe(2);
    });
});
