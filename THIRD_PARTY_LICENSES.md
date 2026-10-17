# Third-party licenses

ZKnotes is licensed under the **GNU Affero General Public License v3.0 only** (see [`LICENSE`](LICENSE)).
This file records the licenses of the code it depends on, and why each is compatible with that choice.

The table below lists the **direct dependencies whose code ships**: every package the three
manifests (`server/`, `client/`, `shared/`) declare under `dependencies`, plus three the client
declares as development dependencies because they are only needed to build it, although what they
produce is in every page it serves — `svelte` (its runtime), `@sveltejs/kit` (the client-side
router) and `tailwindcss` (the generated stylesheet). `@tailwindcss/typography` is in the same
position the other way round: declared under `dependencies`, it is a Tailwind plugin that runs at
build time and ships only as CSS in that stylesheet. The packages these depend on ship too; they are
not listed one by one, but they are in the scan described at the bottom. Build-only tooling
(TypeScript, Biome, Vite, Playwright, …) is not distributed and is therefore not listed, though it
was included in the scan as well.

## Summary

| License | Packages in the table below | Compatible with AGPL-3.0 | Why |
|---|---:|---|---|
| MIT | 49 | yes | Permissive; no conditions beyond attribution, so it can be combined into a copyleft work. |
| Apache-2.0 | 4 | yes | One-way compatible with GPLv3/AGPLv3 — Apache-2.0 code may be included in an AGPLv3 work (the reverse does not hold). |
| ISC | 2 | yes | Functionally equivalent to MIT/BSD-2-Clause. |
| MPL-2.0 OR Apache-2.0 | 1 | yes | MPL-2.0 §3.3 explicitly permits distribution under a GNU secondary license; the Apache-2.0 half of the dual offer is compatible on its own. |
| Unlicense | 1 | yes | Public-domain dedication. |

**No dependency carries a license that conflicts with AGPL-3.0.** In particular there is no
GPL-2.0-only code (which would be incompatible with GPLv3-family terms), and nothing under SSPL,
BUSL, Elastic License, Commons Clause, PolyForm or a proprietary license.

## Direct dependencies that ship

| Package | Version | License | Used by |
|---|---|---|---|
| `@aarkue/tiptap-math-extension` | 1.4.0 | MIT | client |
| `@aws-sdk/client-s3` | 3.1149.0 | Apache-2.0 | server |
| `@aws-sdk/s3-request-presigner` | 3.1149.0 | Apache-2.0 | server |
| `@fastify/cookie` | 11.1.3 | MIT | server |
| `@fastify/cors` | 11.3.1 | MIT | server |
| `@fastify/helmet` | 13.1.2 | MIT | server |
| `@fastify/rate-limit` | 11.2.1 | MIT | server |
| `@noble/ciphers` | 2.4.0 | MIT | shared |
| `@noble/hashes` | 2.4.0 | MIT | shared |
| `@node-rs/argon2` | 2.2.2 | MIT | server |
| `@sveltejs/kit` | 2.70.3 | MIT | client (development dependency) |
| `@tailwindcss/typography` | 0.5.20 | MIT | client (build-time plugin) |
| `@tanstack/svelte-query` | 6.3.1 | MIT | client |
| `@tiptap/core` | 3.31.4 | MIT | client |
| `@tiptap/extension-color` | 3.31.4 | MIT | client |
| `@tiptap/extension-highlight` | 3.31.4 | MIT | client |
| `@tiptap/extension-image` | 3.31.4 | MIT | client |
| `@tiptap/extension-link` | 3.31.4 | MIT | client |
| `@tiptap/extension-mention` | 3.31.4 | MIT | client |
| `@tiptap/extension-placeholder` | 3.31.4 | MIT | client |
| `@tiptap/extension-subscript` | 3.31.4 | MIT | client |
| `@tiptap/extension-superscript` | 3.31.4 | MIT | client |
| `@tiptap/extension-table` | 3.31.4 | MIT | client |
| `@tiptap/extension-table-cell` | 3.31.4 | MIT | client |
| `@tiptap/extension-table-header` | 3.31.4 | MIT | client |
| `@tiptap/extension-table-row` | 3.31.4 | MIT | client |
| `@tiptap/extension-task-item` | 3.31.4 | MIT | client |
| `@tiptap/extension-task-list` | 3.31.4 | MIT | client |
| `@tiptap/extension-text-align` | 3.31.4 | MIT | client |
| `@tiptap/extension-text-style` | 3.31.4 | MIT | client |
| `@tiptap/extension-underline` | 3.31.4 | MIT | client |
| `@tiptap/pm` | 3.31.4 | MIT | client |
| `@tiptap/starter-kit` | 3.31.4 | MIT | client |
| `bits-ui` | 2.19.5 | MIT | client |
| `clsx` | 2.1.1 | MIT | client |
| `cropperjs` | 1.7.0 | MIT | client |
| `dompurify` | 3.4.16 | (MPL-2.0 OR Apache-2.0) | client |
| `drizzle-orm` | 0.45.4 | Apache-2.0 | server |
| `fastify` | 5.12.5 | MIT | server |
| `fastify-plugin` | 6.0.1 | MIT | server |
| `fflate` | 0.8.3 | MIT | client |
| `hash-wasm` | 4.12.0 | MIT | shared |
| `idb` | 8.0.4 | ISC | client |
| `katex` | 0.19.0 | MIT | client |
| `lucide-svelte` | 1.0.1 | ISC | client |
| `marked` | 18.1.0 | MIT | client |
| `minisearch` | 7.2.0 | MIT | client |
| `ms` | 2.1.3 | MIT | server |
| `pino` | 10.4.0 | MIT | server |
| `pino-pretty` | 13.2.0 | MIT | server |
| `postgres` | 3.4.9 | Unlicense | server |
| `svelte` | 5.57.2 | MIT | client (development dependency) |
| `tailwind-merge` | 3.7.0 | MIT | client |
| `tailwindcss` | 4.3.3 | MIT | client (development dependency) |
| `tippy.js` | 6.3.7 | MIT | client |
| `uuidv7` | 1.2.1 | Apache-2.0 | client,server |
| `zod` | 4.6.5 | MIT | shared |

## How this was checked

The `package.json` of every package installed from `bun.lock` (the Bun store under
`node_modules/.bun`) was read and its declared license collected — **406 packages** (383 distinct
names; some are installed in more than one version), including transitive and build-only ones. Their licenses: MIT, Apache-2.0, ISC,
BSD-3-Clause, MPL-2.0, BSD-2-Clause, `MIT OR Apache-2.0`, MIT-0, 0BSD, `MPL-2.0 OR Apache-2.0`,
CC0-1.0, BlueOak-1.0.0 and the Unlicense. The scan looked for license families that cannot be
combined with AGPL-3.0 (`GPL-2.0-only`, SSPL, BUSL, Elastic, Commons Clause, PolyForm, `CC-BY-NC`,
proprietary) and found none. The MPL-2.0 packages are `lightningcss` and its platform binaries, a
CSS tool that runs only at build time.

One package declares no `license` field: **`svelte-toolbelt`** (pulled in transitively by
`bits-ui`), which ships a `LICENSE` file that reads `MIT License, Copyright (c) 2024 Hunter
Johnston`. Its license was taken from that file rather than assumed.

Re-run the scan after changing dependencies; the summary above is only true for the tree it was
generated from.

## Note on this file

This is an engineering record, not legal advice. The compatibility reasoning follows the FSF's own
license list and the text of the licenses involved.
