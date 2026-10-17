<script lang="ts">
// The crop / rotate / zoom modal. It appears ONLY on a deliberate single-image
// action on an image already in the vault — the "Crop" button in an embedded image's editor toolbar
// and "Edit image" in the file detail panel — never on drag/drop batches (those stay a silent
// downscale). It returns a cropped Blob, or the original on "Skip". All of the canvas work happens
// on the plaintext, before encryption.
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import { Check, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";

interface Props {
    file: File | Blob;
    filename: string;
    onCancel: () => void;
    /** `skipped` = the user chose the original, uncropped image (it is still downscaled downstream). */
    onResult: (blob: Blob, skipped: boolean) => void;
}
const { file, filename, onCancel, onResult }: Props = $props();

let dialogEl = $state<HTMLDialogElement | null>(null);
let imgEl = $state<HTMLImageElement | null>(null);
let cropper: Cropper | null = null;
let aspect = $state<number | null>(null); // null = free
let busy = $state(false);

const PRESETS: { label: string; value: number | null }[] = [
    { label: "Free", value: null },
    { label: "1:1", value: 1 },
    { label: "4:3", value: 4 / 3 },
    { label: "16:9", value: 16 / 9 },
];

const mime = $derived(file.type?.startsWith("image/") ? file.type : "image/png");

$effect(() => {
    dialogEl?.showModal();
});

$effect(() => {
    const el = imgEl;
    if (!el) return;
    const url = URL.createObjectURL(file);
    el.src = url;
    const c = new Cropper(el, {
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        responsive: true,
        checkOrientation: true,
    });
    cropper = c;
    return () => {
        c.destroy();
        cropper = null;
        URL.revokeObjectURL(url);
    };
});

function setAspect(value: number | null) {
    aspect = value;
    cropper?.setAspectRatio(value ?? Number.NaN);
}

function doCrop() {
    if (!cropper || busy) return;
    busy = true;
    const canvas = cropper.getCroppedCanvas({
        maxWidth: 4096,
        maxHeight: 4096,
        imageSmoothingQuality: "high",
    });
    canvas.toBlob(
        (blob) => {
            busy = false;
            if (blob) onResult(blob, false);
        },
        mime,
        0.92,
    );
}

function skip() {
    onResult(file, true);
}
</script>

<dialog
    bind:this={dialogEl}
    oncancel={(e) => { e.preventDefault(); onCancel(); }}
    class="m-auto w-full max-w-2xl bg-[var(--surface-app)] border border-[var(--stroke)] rounded-xl shadow-2xl p-0 max-h-[90vh]
           backdrop:bg-black/70 backdrop:backdrop-blur-sm"
>
    <div class="flex flex-col max-h-[90vh] overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-[var(--stroke)]">
            <h2 class="text-sm font-semibold text-[var(--text)] truncate">Crop image · <span class="font-mono text-[var(--text-muted)]">{filename}</span></h2>
            <Button variant="ghost" size="icon" onclick={onCancel} title="Close">
                <X class="w-4 h-4" />
            </Button>
        </div>

        <div class="bg-black/40 flex items-center justify-center" style="height: 50vh;">
            <!-- svelte-ignore a11y_img_redundant_alt -->
            <img bind:this={imgEl} alt="Crop preview" class="max-w-full block" style="max-height: 50vh;" />
        </div>

        <div class="px-5 py-3 border-t border-[var(--stroke)] flex flex-wrap items-center gap-3">
            <div class="flex items-center gap-1">
                {#each PRESETS as p}
                    <Button
                        variant={aspect === p.value ? "primary" : "normal"}
                        size="sm"
                        onclick={() => setAspect(p.value)}
                    >
                        {p.label}
                    </Button>
                {/each}
            </div>
            <div class="flex items-center gap-1 ml-auto">
                <Button variant="normal" size="icon" title="Rotate left" onclick={() => cropper?.rotate(-90)}>
                    <RotateCcw class="w-[0.9375rem] h-[0.9375rem]" />
                </Button>
                <Button variant="normal" size="icon" title="Rotate right" onclick={() => cropper?.rotate(90)}>
                    <RotateCw class="w-[0.9375rem] h-[0.9375rem]" />
                </Button>
                <Button variant="normal" size="icon" title="Zoom in" onclick={() => cropper?.zoom(0.1)}>
                    <ZoomIn class="w-[0.9375rem] h-[0.9375rem]" />
                </Button>
                <Button variant="normal" size="icon" title="Zoom out" onclick={() => cropper?.zoom(-0.1)}>
                    <ZoomOut class="w-[0.9375rem] h-[0.9375rem]" />
                </Button>
            </div>
        </div>

        <div class="px-5 py-3 border-t border-[var(--stroke)]">
            <DialogActions>
                <Button onclick={skip} disabled={busy}>Skip (use original)</Button>
                <Button variant="primary" onclick={doCrop} disabled={busy}>
                    <Check class="w-[0.875rem] h-[0.875rem]" /> {busy ? "Cropping…" : "Crop & upload"}
                </Button>
            </DialogActions>
        </div>
    </div>
</dialog>
