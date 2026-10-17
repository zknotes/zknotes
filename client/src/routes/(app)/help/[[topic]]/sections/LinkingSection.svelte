<script lang="ts">
import { Link2 } from "lucide-svelte";
</script>

<section>
    <h2 class="text-2xl font-bold text-[var(--text)] mb-4">Linking Notes</h2>
    <p class="text-[var(--text-muted)] text-sm mb-8">
        You can connect notes to each other with internal links. Linked notes appear with a dashed underline and open with a single click — useful for wikis, indexes, and cross-references.
    </p>

    <div class="bg-[var(--surface-panel)] border border-[var(--stroke-soft)] rounded-2xl p-6 shadow-sm">
        <div class="flex items-center gap-3 mb-4">
            <div class="p-2 bg-brand0/10 rounded-xl text-brand0">
                <Link2 class="w-5 h-5" />
            </div>
            <h3 class="text-lg font-medium text-[var(--text-sub)]">How to link to another note</h3>
        </div>

        <div class="space-y-4 text-sm text-[var(--text-muted)] leading-relaxed">
            <p>
                There are two ways to create a link:
            </p>
            <ul class="list-disc pl-5 space-y-2">
                <li>
                    <strong class="text-[var(--text-sub)]">Type <code class="bg-[var(--surface-raised)] px-1.5 py-0.5 rounded text-[var(--text-sub)] text-xs">@</code> in the editor</strong> — a picker appears; choose the note you want to link. You can keep typing to filter the list.
                </li>
                <li>
                    <strong class="text-[var(--text-sub)]">Use the Link button in the toolbar</strong> — the popover has a "Link to note" section with search, alongside the usual field for external URLs.
                </li>
            </ul>
            <p>
                You can also drag a note from the sidebar into the editor to insert a link at the drop position.
            </p>
            <p>
                If a linked note is renamed, the link text updates automatically. If a note is deleted, the link is shown as broken (strikethrough) so you can clean it up.
            </p>
        </div>
    </div>
</section>