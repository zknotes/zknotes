// The file-chip DOM builders for the encFile NodeView — lifted out of enc-file-node.ts.
// The two variants share an icon/accent/ext core:
//   - makeFileChip: a static card (download / error / the deleted placeholder)
//   - makePendingFileChip: a card with a live progress bar + retry/abort for
//     files not yet uploaded (`local:`)
import {
    FILE_CHIP_DOWNLOAD_ICON_SVG,
    FILE_CHIP_REMOVE_ICON_SVG,
    FILE_CHIP_RESTORE_ICON_SVG,
    fileExtLabel,
    getFileChipAccentClasses,
    getFileChipIconSvg,
} from "$lib/core/ui/file-chip-icons";
import { computeUploadDisplayPct } from "$lib/modules/files/upload";
import type { UploadState } from "$lib/modules/files/upload-manager";

/**
 * A stable hook on the element carrying the file's name. The NodeView uses it to refresh the name after a rename —
 * do not rely on the Tailwind classes (they change with the design and would break the sync silently).
 */
export const CHIP_NAME_ATTR = "data-chip-name";
/** A stable hook on the TRASHED placeholder's Restore button — the tests and E2E look it up by this. */
export const CHIP_RESTORE_ATTR = "data-chip-restore";

/** The shared core: a container plus an icon badge (the variants add their own content). */
function chipShell(containerClass: string, iconClass: string, iconHtml: string): HTMLElement {
    const ch = document.createElement("div");
    ch.className = containerClass;
    const iconWrap = document.createElement("div");
    iconWrap.className = `flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-md ${iconClass}`;
    iconWrap.innerHTML = iconHtml;
    ch.appendChild(iconWrap);
    return ch;
}

export interface FileChipOptions {
    mime?: string | null;
    /** The error placeholder (">50MB", say) — the red style. */
    errorMsg?: string;
    /** The deleted placeholder ("File deleted", say) — grey, with no buttons */
    deletedMsg?: string;
    /**
     * A soft secondary line ("Can't play this codec in the browser", say) — it is not an error style;
     * it is used alongside the download when the file is fine but the inline player does not work.
     */
    subtitle?: string;
    /** When it is set, the chip gets a download icon. */
    downloadFileId?: string;
    /** A click on the download icon — the NodeView dispatches an encfile:download event. */
    onDownload?: (fileId: string) => void;
    /** A click on the remove icon (it appears alongside deletedMsg when the file was deleted permanently) */
    onRemove?: () => void;
    /**
     * A click on the restore icon — the TRASHED placeholder ("File in trash / Restore").
     * For the `deleted_at` state only: a permanently deleted file cannot be resurrected, so it gets `onRemove`.
     */
    onRestore?: () => void;
}

/** A block-style file card for non-image files (resolved or an error). */
export function makeFileChip(name: string, opts: FileChipOptions = {}): HTMLElement {
    const ext = fileExtLabel(name);
    const isError = !!opts.errorMsg;
    const isDeleted = !!opts.deletedMsg;
    const state = { isError, isDeleted };

    const ch = chipShell(
        [
            "flex items-center gap-3 px-4 py-3 rounded-lg border select-none",
            "max-w-sm transition-colors",
            isError
                ? "bg-[color-mix(in_srgb,var(--surface-panel)_60%,transparent)] border-red-800/40 text-[var(--text-dim)] cursor-default"
                : isDeleted
                  ? "bg-[color-mix(in_srgb,var(--surface-panel)_40%,transparent)] border-[color-mix(in_srgb,var(--stroke)_40%,transparent)] text-[var(--text-dim)] cursor-default opacity-80"
                  : "bg-[color-mix(in_srgb,var(--surface-panel)_60%,transparent)] border-[color-mix(in_srgb,var(--stroke)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--surface-raised)_80%,transparent)] hover:border-[var(--text-dim)] text-[var(--text-sub)] cursor-default",
        ].join(" "),
        getFileChipAccentClasses(opts.mime, ext, state),
        getFileChipIconSvg(opts.mime, ext, state),
    );

    // The middle: the filename + the ext badge
    const textWrap = document.createElement("div");
    textWrap.className = "flex-1 min-w-0 flex flex-col gap-0.5";

    const nameEl = document.createElement("div");
    nameEl.className = "text-sm font-medium leading-snug truncate";
    nameEl.setAttribute(CHIP_NAME_ATTR, "");
    nameEl.textContent = name;
    if (isError) {
        nameEl.classList.add("text-red-400");
    } else if (isDeleted) {
        nameEl.classList.add("line-through", "text-[var(--text-dim)]");
    }

    const subEl = document.createElement("div");
    // The subtitle and the error are not necessarily an "ext" — the normal case is an uppercase ext; a hint uses sentence case.
    const softHint = !isError && !isDeleted && opts.subtitle ? opts.subtitle : null;
    subEl.className = softHint
        ? "text-xs text-[var(--text-dim)] leading-snug normal-case tracking-normal"
        : "text-xs text-[var(--text-dim)] uppercase tracking-wide";
    subEl.textContent = isError
        ? (opts.errorMsg as string)
        : isDeleted
          ? (opts.deletedMsg as string)
          : (softHint ?? ext);

    textWrap.appendChild(nameEl);
    textWrap.appendChild(subEl);
    ch.appendChild(textWrap);

    if (opts.downloadFileId) {
        const downloadFileId = opts.downloadFileId;
        // The download icon on the right — it alone starts a download
        const dlIcon = document.createElement("div");
        dlIcon.className =
            "flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text-sub)] hover:bg-[color-mix(in_srgb,var(--surface-raised)_60%,transparent)] transition-colors cursor-pointer";
        dlIcon.title = "Download";
        dlIcon.innerHTML = FILE_CHIP_DOWNLOAD_ICON_SVG;
        ch.appendChild(dlIcon);

        dlIcon.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        dlIcon.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            opts.onDownload?.(downloadFileId);
        });
    } else if (opts.onRestore) {
        // The restore icon on the right — the TRASHED placeholder. It brings the file back from Trash without going to /trash.
        const rsIcon = document.createElement("div");
        rsIcon.className =
            "flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--surface-raised)_60%,transparent)] transition-colors cursor-pointer";
        rsIcon.title = "Restore from trash";
        rsIcon.setAttribute(CHIP_RESTORE_ATTR, "");
        rsIcon.innerHTML = FILE_CHIP_RESTORE_ICON_SVG;
        ch.appendChild(rsIcon);

        rsIcon.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        rsIcon.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            opts.onRestore?.();
        });
    } else if (opts.onRemove) {
        // The remove icon on the right
        const rmIcon = document.createElement("div");
        rmIcon.className =
            "flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-dim)] hover:text-red-400 hover:bg-red-900/20 transition-colors cursor-pointer";
        rmIcon.title = "Remove reference";
        rmIcon.innerHTML = FILE_CHIP_REMOVE_ICON_SVG;
        ch.appendChild(rmIcon);

        rmIcon.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        rmIcon.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            opts.onRemove?.();
        });
    }

    return ch;
}

export interface PendingChipHandle {
    el: HTMLElement;
    /** Keeps the progress/error display in step with the upload's state. */
    update(state: UploadState | undefined): void;
}

export interface PendingChipHandlers {
    onRetry: () => void;
    onAbort: () => void;
}

/**
 * The pending non-image card: an inline progress bar while the upload runs, with retry/abort
 * buttons on an error.
 */
export function makePendingFileChip(
    fileName: string,
    handlers: PendingChipHandlers,
): PendingChipHandle {
    const ext = fileExtLabel(fileName);

    const ch = chipShell(
        "flex items-center gap-3 px-4 py-3 rounded-lg border border-[color-mix(in_srgb,var(--stroke)_50%,transparent)] bg-[color-mix(in_srgb,var(--surface-panel)_60%,transparent)] max-w-sm select-none",
        "bg-blue-900/30 text-blue-400",
        getFileChipIconSvg(null, "FILE"),
    );

    // The text + progress column
    const textWrap = document.createElement("div");
    textWrap.className = "flex-1 min-w-0 flex flex-col gap-1";

    const topRow = document.createElement("div");
    topRow.className = "flex items-center gap-2";
    const nameEl = document.createElement("span");
    nameEl.className = "text-sm font-medium text-[var(--text-sub)] truncate flex-1";
    nameEl.setAttribute(CHIP_NAME_ATTR, "");
    nameEl.textContent = fileName;
    const extBadge = document.createElement("span");
    extBadge.className = "text-2xs text-[var(--text-dim)] uppercase tracking-wide flex-shrink-0";
    extBadge.textContent = ext;
    topRow.appendChild(nameEl);
    topRow.appendChild(extBadge);

    const progressRow = document.createElement("div");
    progressRow.className =
        "relative h-1 w-full bg-[color-mix(in_srgb,var(--surface-raised)_50%,transparent)] rounded-full overflow-hidden mt-1";
    const bar = document.createElement("div");
    bar.className = "absolute inset-0 bg-blue-500 pointer-events-none transition-all duration-300";
    bar.style.width = "8%";
    progressRow.appendChild(bar);

    textWrap.appendChild(topRow);

    const statusEl = document.createElement("div");
    statusEl.className = "text-xs text-amber-400 truncate mt-0.5";
    textWrap.appendChild(statusEl);
    textWrap.appendChild(progressRow);
    ch.appendChild(textWrap);

    const update = (st: UploadState | undefined) => {
        ch.querySelector(".chip-actions")?.remove();
        let statusText = "Upload paused";
        let isUploading = false;

        if (st && st.status === "uploading") {
            isUploading = true;
            const total = st.totalChunks ?? 0;
            const chunkIndex = st.chunkIndex ?? 0;
            const pct = computeUploadDisplayPct(st) ?? 0;

            statusText =
                st.phase === "finalizing" || st.phase === "committing"
                    ? "Finishing…"
                    : total > 1
                      ? `Uploading ${pct}% (${Math.min(chunkIndex + 1, total)}/${total})`
                      : `Uploading ${pct}%`;

            bar.style.width = `${pct}%`;
            bar.className =
                "absolute inset-0 bg-blue-500/20 pointer-events-none transition-all duration-300";
        } else {
            statusText = !st ? "Upload paused" : st.error || "Upload failed";
            bar.style.width = "100%";
            bar.className = "absolute inset-0 bg-red-500/20 pointer-events-none";
        }

        statusEl.textContent = statusText;

        const btnRow = document.createElement("div");
        btnRow.className = "chip-actions mt-1.5 flex gap-2 pointer-events-auto";

        if (!isUploading) {
            const retryBtn = document.createElement("button");
            retryBtn.type = "button";
            retryBtn.className =
                "text-xs px-2.5 py-1 rounded bg-brand0 hover:bg-brand0 text-white font-medium transition-colors";
            retryBtn.textContent = !st ? "Resume" : "Retry";
            retryBtn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
            retryBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                handlers.onRetry();
            });
            btnRow.appendChild(retryBtn);
        }

        const abortBtn = document.createElement("button");
        abortBtn.type = "button";
        abortBtn.className =
            "text-xs px-2.5 py-1 rounded bg-[var(--surface-raised)] hover:bg-[var(--row-hover)] text-[var(--text-sub)] transition-colors";
        abortBtn.textContent = !st ? "Cancel" : "Abort";
        abortBtn.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.preventDefault();
        });
        abortBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            handlers.onAbort();
        });
        btnRow.appendChild(abortBtn);

        textWrap.appendChild(btnRow);
    };

    return { el: ch, update };
}
