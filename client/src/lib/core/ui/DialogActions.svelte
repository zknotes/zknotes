<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    children?: Snippet;
    class?: string;
}

const { children, class: extraClass = "" }: Props = $props();
</script>

<!-- 
  DialogActions: standard footer row for modals.
  - Enforces right alignment (justify-end) as per UX spec.
  - Expects children in order: secondary (Cancel) first, then primary.
  - Use with Dialog footer snippet.
-->
<div class="flex items-center gap-2 justify-end {extraClass}">
	{@render children?.()}
</div>
