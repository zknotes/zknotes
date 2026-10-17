/** Standard base64 (44 characters) for the 32 B verifier key on the wire. */
export function bytesToB64(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}
