import type {
    CreateSealRequest,
    PutSealRequest,
    SealBlockHeaderResponse,
    SealListResponse,
    SealSubmitReply,
    SealUpgradeReply,
    SealWire,
    UpgradeSealRequest,
} from "@zknotes/shared";
import { apiFetch } from "./client";

/**
 * Relays the commitment to the instance's calendars and opens a pending seal row. The calendars
 * can take a few seconds each (the server gives each ten); the server waits for all of them.
 */
export function createSeal(body: CreateSealRequest) {
    return apiFetch<{ id: string; replies: SealSubmitReply[] }>("/seals", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function putSeal(id: string, body: PutSealRequest) {
    return apiFetch<SealWire>(`/seals/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export function upgradeSeal(id: string, body: UpgradeSealRequest) {
    return apiFetch<{ results: SealUpgradeReply[] }>(`/seals/${id}/upgrade`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function listSeals() {
    return apiFetch<SealListResponse>("/seals");
}

export function deleteSeal(id: string) {
    return apiFetch<void>(`/seals/${id}`, { method: "DELETE" });
}

/** A block header relayed by the server — untrusted; `block-header.ts` checks it before use. */
export function getSealBlock(height: number) {
    return apiFetch<SealBlockHeaderResponse>(`/seals/blocks/${height}`);
}
