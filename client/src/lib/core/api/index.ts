/**
 * The HTTP layer's public API — every client → server call goes through here.
 *
 *   client.ts      — apiFetch transport (base URL, cookies, 401 handling)
 *   auth.ts        — /auth/* (login, register, me, change-password, …)
 *   items.ts       — /items batch push + delta pull
 *   history.ts     — /items/:id/history snapshots
 *   files.ts       — the /uploads chunk pipeline (JSON through apiFetch, raw fetch for the bytes)
 *   diagnostics.ts — /client-error, /client-log (fire-and-forget)
 *
 * The UI and the services import the domain functions — the endpoint strings and the request shapes
 * live only here (one place of truth).
 */
export {
    changePassword,
    deleteAccount,
    getKdfParams,
    getMe,
    type KdfMetadata,
    login,
    logout,
    createVault,
} from "./auth";
export {
    API_BASE,
    ApiError,
    apiFetch,
    isServerUnreachableError,
    setUnauthorizedHandler,
    UnauthorizedError,
} from "./client";
export { reportClientError, sendClientLog } from "./diagnostics";
export {
    abortUpload,
    chunkStatus,
    finalizeUpload,
    getChunk,
    getStorage,
    getUploadStatus,
    isPermanentStorageRejection,
    isPresignRejected,
    mintUploadUrls,
    openUpload,
    openUploadSession,
    pingUploadSession,
    putChunk,
    S3PutError,
    type StorageInfo,
} from "./files";
export {
    clearAllSnapshots,
    createSnapshot,
    deleteSnapshot,
    listSnapshots,
} from "./history";
export { type PullDelta, type PushBatchResult, pullPage, pullSince, pushBatch } from "./items";
export {
    abortRestoreSession,
    commitRestoreSession,
    createRestoreSession,
    getRestoreSession,
    pingRestoreSession,
    RestoreClientError,
    type RestoreSessionView,
    type RestoreVerdict,
    type RestoreVerifyResult,
    stageRestoreItems,
    verifyRestoreSession,
} from "./restore";
export {
    createShare,
    getShareMeta,
    listShares,
    revokeShare,
    type ShareListEntry,
    type ShareMetaResponse,
    type ShareViewResponse,
    viewShare,
} from "./shares";
