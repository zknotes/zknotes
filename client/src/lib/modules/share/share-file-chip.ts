import {
    FILE_CHIP_DOWNLOAD_ICON_SVG,
    fileExtLabel,
    getFileChipAccentClasses,
    getFileChipIconSvg,
} from "$lib/core/ui/file-chip-icons";

/** A chip carrying data-share-file-id, for event delegation on the share page. */
export function makeShareFileChip(fileId: string, name: string, mime?: string | null): HTMLElement {
    const ext = fileExtLabel(name);
    const chip = document.createElement("div");
    chip.className =
        "share-file-chip flex items-center gap-3 px-4 py-3 rounded-lg border border-[var(--stroke)] bg-[var(--surface-raised)]/30 hover:bg-[var(--surface-raised)]/50 hover:border-[var(--stroke)]/80 max-w-sm my-5 select-none cursor-pointer transition-colors";
    chip.setAttribute("data-share-file-id", fileId);
    chip.setAttribute("data-share-download", "true");

    const iconWrap = document.createElement("div");
    iconWrap.className = `flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-md ${getFileChipAccentClasses(mime, ext)}`;
    iconWrap.innerHTML = getFileChipIconSvg(mime, ext);
    chip.appendChild(iconWrap);

    const textWrap = document.createElement("div");
    textWrap.className = "flex-1 min-w-0 flex flex-col gap-0.5";

    const nameEl = document.createElement("div");
    nameEl.className = "text-sm font-medium leading-snug truncate";
    nameEl.textContent = name;

    const subEl = document.createElement("div");
    subEl.className = "text-xs text-[var(--text-muted)] uppercase tracking-wide";
    subEl.textContent = ext;

    textWrap.appendChild(nameEl);
    textWrap.appendChild(subEl);
    chip.appendChild(textWrap);

    const dlBtn = document.createElement("div");
    dlBtn.className =
        "share-file-download flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[var(--text-muted)] pointer-events-none";
    dlBtn.setAttribute("aria-hidden", "true");
    dlBtn.setAttribute("title", "Download");
    dlBtn.innerHTML = FILE_CHIP_DOWNLOAD_ICON_SVG;
    chip.appendChild(dlBtn);

    return chip;
}
