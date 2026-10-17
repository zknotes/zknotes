// Vault creation — the core's shared logic.
//
// A vault is a `users` row plus the crypto material the client derived **on the device**. The server
// never sees the password: it receives the Auth Key (which it hashes) and the wrapped Vault Key
// (which it only stores).
//
// The policy of "may this be created at all" is NOT here — that is seam 2 (`registrationStatus`) or
// taking the route over (seam 3). This module knows only **how** a vault is created, not **when**.
import { assertKdfParamsFloor, type KdfParams, normalizeEmail } from "@zknotes/shared";
import { uuidv7 } from "uuidv7";
import { users } from "../db/schema";
import { hashAuthKey } from "./auth-service";

/** The crypto material the client sends; all base64, with the formats validated by `VaultCreateSchema`. */
export type VaultMaterial = {
    readonly email: string;
    readonly auth_key: string;
    readonly kdf_salt: string;
    readonly kdf_params: KdfParams;
    readonly encrypted_vault_key: string;
    readonly vault_key_nonce: string;
};

type Tx = Parameters<Parameters<typeof import("../db").db.transaction>[0]>[0];

/**
 * Insert the `users` row from the client's material and return the `userId`.
 *
 * Called **inside a transaction** so the caller (the core for a self-host, or an extension) can
 * add its own work in the same step — the link to an account, a plan, whatever it needs.
 */
export async function createVaultUser(
    tx: Tx,
    material: VaultMaterial,
    quota: { storageQuota: number; maxFileSize: number },
): Promise<string> {
    // The KDF floor is a security floor, not shape validation — weak parameters mean a weak Master Key.
    assertKdfParamsFloor(material.kdf_params);

    const userId = uuidv7();
    await tx.insert(users).values({
        id: userId,
        email: normalizeEmail(material.email),
        auth_key_hash: await hashAuthKey(material.auth_key),
        kdf_salt: Buffer.from(material.kdf_salt, "base64"),
        kdf_params: JSON.stringify(material.kdf_params),
        encrypted_vault_key: Buffer.from(material.encrypted_vault_key, "base64"),
        vault_key_nonce: Buffer.from(material.vault_key_nonce, "base64"),
        storage_quota: quota.storageQuota,
        max_file_size: quota.maxFileSize,
    });
    return userId;
}
