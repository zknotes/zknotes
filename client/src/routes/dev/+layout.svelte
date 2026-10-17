<script lang="ts">
// A minimal layout for the dev tools (/dev/*).
// It skips the app auth loader and the (app) sidebar.
// The root layout still runs (theme, query client...), but it shows no auth checker for this subtree.

let { children } = $props();
</script>

{@render children()}
