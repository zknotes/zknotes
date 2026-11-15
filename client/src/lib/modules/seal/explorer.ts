/**
 * The public Bitcoin explorer the seal links to. A link is only a signpost to the public record:
 * the proof is checked with the OpenTimestamps client, never by trusting an explorer, and any
 * explorer shows the same transaction for the same txid. Nothing here is fetched; the explorer
 * sees a request only when someone opens a link, and the txid it sees is shared by every
 * commitment the calendar put in that transaction.
 */
const EXPLORER = "https://mempool.space";

export function txUrl(txid: string): string {
    return `${EXPLORER}/tx/${txid}`;
}

export function blockUrl(height: number): string {
    return `${EXPLORER}/block/${height}`;
}
