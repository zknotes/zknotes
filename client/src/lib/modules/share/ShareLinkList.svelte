<script lang="ts">
import { createQuery, useQueryClient } from "@tanstack/svelte-query";
import { onMount } from "svelte";
import { Link2, Trash2 } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import { getDeletedItems, getTreeItems } from "$lib/core/data/items";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import type { ShareListEntry } from "$lib/core/api/shares";
import { formatDate } from "$lib/core/utils/format";
import { listShares, revokeShare } from "./share-service";
import { SECOND_MS } from "$lib/core/utils/duration";

const queryClient = useQueryClient();

const sharesQuery = createQuery(() => ({
    queryKey: ["shares"],
    queryFn: listShares,
    staleTime: 30 * SECOND_MS,
}));

let titleById = $state(new Map<string, string>());

onMount(async () => {
    const [tree, deleted] = await Promise.all([getTreeItems(), getDeletedItems()]);
    const map = new Map<string, string>();
    for (const item of [...tree, ...deleted]) {
        map.set(item.id, item.title);
    }
    titleById = map;
});

function statusLabel(row: ShareListEntry): string {
    if (row.source_deleted) return "Source deleted";
    if (row.revoked_at) return "Revoked";
    if (row.expires_at && row.expires_at * 1000 < Date.now()) return "Expired";
    return "Active";
}

function resolveNoteLabel(row: ShareListEntry): { text: string; fallback: boolean } {
    const title = titleById.get(row.source_item_id);
    if (title) return { text: title, fallback: false };
    if (row.source_deleted) return { text: "Deleted note", fallback: true };
    return { text: "Not downloaded yet", fallback: true };
}

async function handleRevoke(id: string) {
    try {
        await revokeShare(id);
        await queryClient.invalidateQueries({ queryKey: ["shares"] });
        globalToasts.add({ message: "Link revoked", variant: "success" });
    } catch (e) {
        globalToasts.add({
            message: e instanceof Error ? e.message : "Revoke failed",
            variant: "error",
        });
    }
}

function formatTs(sec: number | null): string {
    if (!sec) return "—";
    return formatDate(sec);
}
</script>

<div class="space-y-4 w-full text-left">
    {#if sharesQuery.isLoading}
        <p class="text-sm text-[var(--text-muted)]">Loading…</p>
    {:else if !sharesQuery.data?.length}
        <p class="text-sm text-[var(--text-muted)]">No shared links yet.</p>
    {:else}
        <div class="w-full overflow-x-auto rounded-xl border border-[var(--stroke)]">
            <table class="w-full min-w-[44rem] text-sm text-left">
                <thead class="bg-[var(--surface-raised)]/40 text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                    <tr>
                        <th class="px-4 py-2.5 text-left min-w-[12rem]">Note</th>
                        <th class="px-4 py-2.5 text-left whitespace-nowrap">Created</th>
                        <th class="px-4 py-2.5 text-left whitespace-nowrap">Expires</th>
                        <th class="px-4 py-2.5 text-left">Views</th>
                        <th class="px-4 py-2.5 text-left">Files</th>
                        <th class="px-4 py-2.5 text-left">Status</th>
                        <th class="px-4 py-2.5 text-left w-12"></th>
                    </tr>
                </thead>
                <tbody>
                    {#each sharesQuery.data as row}
                        {@const noteLabel = resolveNoteLabel(row)}
                        <tr class="border-t border-[var(--stroke)]">
                            <td class="px-4 py-2.5 text-left min-w-[12rem] max-w-[20rem] truncate {noteLabel.fallback ? 'text-[var(--text-muted)] italic' : ''}">
                                {noteLabel.text}
                            </td>
                            <td class="px-4 py-2.5 text-left whitespace-nowrap">{formatTs(row.created_at)}</td>
                            <td class="px-4 py-2.5 text-left whitespace-nowrap">{formatTs(row.expires_at)}</td>
                            <td class="px-4 py-2.5 text-left">{row.view_count}{row.max_views === 1 ? " (one-time)" : ""}</td>
                            <td class="px-4 py-2.5 text-left">{row.attachment_count > 0 ? row.attachment_count : "—"}</td>
                            <td class="px-4 py-2.5 text-left">{statusLabel(row)}</td>
                            <td class="px-4 py-2.5 text-left">
                                {#if !row.revoked_at && statusLabel(row) === "Active"}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        title="Revoke"
                                        onclick={() => handleRevoke(row.id)}
                                    >
                                        <Trash2 class="w-4 h-4" />
                                    </Button>
                                {/if}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    <p class="flex items-center gap-2 text-xs text-[var(--text-muted)] text-left">
        <Link2 class="w-3.5 h-3.5 shrink-0" />
        Open a note and use Share in the header to create a new link.
    </p>
</div>