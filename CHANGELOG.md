# Changelog

All notable user-facing changes to ZKnotes are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Added

- Choosing a master password, when creating the vault or changing the password, now shows advice
  and a strength meter (weak, fair, strong). The meter counts length most, credits a mix of
  capitals, numbers and symbols, and marks well-known passwords and patterns like `1234` as weak.
  It never refuses a password: a weak one gets a single warning above the button, and pressing the
  button again keeps it.

### Changed

- Settings: the "Delete Account" tab is now called "Delete vault", and its text says what it
  does — delete this vault and everything in it. On the hosted service the account that owns the
  vault is a separate thing and is deleted separately; on a self-hosted instance the vault is the
  whole account, so the new name is accurate in both cases. Nothing else changed: same route,
  same password confirmation, same effect.

### Fixed

- Settings → Delete vault now says which vault it deletes (the address you are signed in as), and
  when you arrive from the account area it refuses to delete a different vault than the one you
  came for — the browser may be signed in to another vault, because the account area and the app
  keep separate sessions. The page remembers which vault you came for, so the check still holds
  after you sign out and sign in to the right vault, or come back from another Settings tab; and
  when it cannot confirm which vault this browser is signed in to, it refuses to delete until a
  retry succeeds. After the deletion on a hosted instance the app takes you back to your account
  instead of to the sign-in screen, where there was nothing left to sign in to.
- Markdown export: a table cell whose text has a backslash right before a pipe (`a\|b`) stays one
  cell instead of splitting in two.
- Search: text that looks like an HTML entity, such as `&lt;` typed into a note, is indexed as typed
  instead of as `<`.
- `docker/setup.sh` on rootless Docker no longer turns off Docker's userland proxy while the
  `br_netfilter` kernel module is missing. Docker refused that setting and stopped starting; the
  script now prints the command that loads the module first. If Docker still does not come back
  after a change the script made, it takes the change back out and starts Docker again.

## [0.2.0] - 2026-10-17

### Added

- First public release of ZKnotes under the AGPL-3.0-only licence.
- End-to-end encryption of every note, folder, file and title: keys are derived from your password
  with Argon2id in the browser and content is sealed with XChaCha20-Poly1305. The server stores the
  content only encrypted and cannot read it; `SECURITY.md` lists the metadata it does see. There is
  no password recovery.
- A rich-text editor with tables, images, code blocks, links between notes and Markdown import.
- Folders with drag-and-drop ordering, starred and recent items, and a trash with restore.
- Encrypted file attachments with resumable uploads, thumbnails and in-browser preview.
- Offline use as an installable app: changes made offline sync when the connection returns, and
  conflicting edits are kept as copies for you to resolve.
- Note history with restore of earlier versions.
- Read-only share links for notes, with optional expiry, one-time use and a password.
- Client-side search that never sends your words to the server, tolerant of typos and diacritics.
- A full backup of the vault, optionally sealed with its own passphrase, HTML export, and restore
  from a backup.
- Self-hosting with Docker Compose (Caddy, PostgreSQL and any S3-compatible storage).
- `docker/setup.sh` sets up an instance with one command: it asks for the domain, writes
  `docker/.env` with freshly generated secrets (never overwriting what is there), sets up file
  storage, checks rootless Docker, builds, starts and waits for the API. File storage can now be
  built in — a Garage node in the compose file, served on its own domain — so no outside S3 account
  is needed.
- The API warns in its log when every visitor reaches it from one private address, which means the
  reverse proxy cannot see visitors' own addresses and every per-address limit is shared.
- Settings → Backup & Export can export the notes as Markdown files, in a ZIP whose folders mirror
  the vault's, with links between notes and embedded images pointing at the right files.
- The sign-in, account-creation and shared-note pages show the licence (GNU AGPL-3.0, without
  warranty) and, when `SOURCE_URL` is set, a link to the source code — share recipients and
  visitors never see Settings → About, where the link used to be the only one.

### Changed

- The Compose project is named `zknotes`, so container and volume names (`zknotes_pgdata`) no
  longer depend on the directory. The database sits on a `backend` network that Caddy cannot
  reach, and `DNS_RESOLVER_1`/`DNS_RESOLVER_2` replace the public resolvers the containers use.
- `SECURITY.md` lists what the server can and cannot read, says where the keys live — including the
  per-tab `sessionStorage` copy of the Vault Key that lets a reload skip the password — and says
  which releases get security fixes, and what changing the password or stopping a share does not
  undo.
- `server/.env.example` sets `SOURCE_URL` to the upstream repository and documents every variable
  the server reads; `docker/README.md` covers `SOURCE_URL`, what the object storage and its key must
  be, and how to size the disk.
- `build.sh` is gone, and the README no longer offers `bun run preview` as a way to run in
  production: Docker Compose is the deployment, because the security headers come from its nginx
  and Caddy configuration.
- `THIRD_PARTY_LICENSES.md` covers Svelte, SvelteKit and Tailwind, whose code ships in every page.
- `GET /items` requires `limit`: every pull is paged, and a request without it gets
  `400 invalid_input` instead of the account's whole item set in one unbounded response. The app has
  always sent it. A page now loads only the rows that fit its byte budget, instead of up to a
  thousand full rows before cutting.

### Fixed

- Pushing an item no longer sends the client's own bookkeeping to the server: a conflict copy's
  link to its original (kept inside the ciphertext by design) and the text of an earlier push error.
- The image button no longer offers to insert an image from a web address, which the content
  policy blocks so it could never show: it uploads from the device. The editor help and the "Add to
  Files" error no longer blame CORS. A self-hosted instance no longer shows plan or upgrade wording.

- `ANALYTICS_DISABLED=1` now stops all analytics collection: before, it stopped only the daily job,
  so per-user activity rows kept being written and, with the job off, were never deleted. Rows
  collected earlier still expire on schedule. The collected data and settings are documented in
  `server/.env.example` and `docker/README.md`.

- A sync update that declared an existing folder to be a note could move it under its own child.
  The server now refuses an update that changes an item's type.
- Restoring a backup can no longer change an existing item's type, and a restored item has to sit
  under the right kind of parent.
- Restoring over a file whose blob a conflict copy shares no longer schedules that blob for
  deletion; a blob two restored files shared is freed once; restores with more than 2 GiB of files
  no longer fail.
- The blob sweep no longer deletes a file that a conflict copy took back while the sweep ran, and
  old deleted-item records whose parents form a cycle are cleaned up.
- Editing an item in the trash counts its size change against the trash.
- A backup containing a folder cycle no longer crashes the restore wizard.
- `MAX_FILE_COUNT` lowers the file ceiling for every upload, not only for a restore.
- With `ANALYTICS_DISABLED=1` the sign-in and registration counters are not kept even in memory.
- The start of an upload is logged at debug level, not info, so the production log no longer
  records which account uploaded how much.
- The cleanup of old deleted-item records no longer deletes a live note whose parent folder and
  grandparent folder were both deleted long ago.

- The documented database restore works: it loads the dump into a new database in a single
  transaction and swaps it in only once it has loaded, so a failed restore changes nothing and a
  dump from an older version restores too. The backup now covers the bucket and `docker/.env` as
  well (`docker/README.md`, §4, which also covers PostgreSQL upgrades).
- The documentation no longer says the storage quota bounds the disk: it is enforced at 1.2 × the
  quota, and at 2 × while a restore is in progress.

### Security

- The server refuses to start in production while `COOKIE_SECRET` or `KDF_FAKE_SEED` still holds
  the placeholder value from `server/.env.example`.
- HTTP/3 is off: rootless Docker does not pass a UDP client's address through, so every HTTP/3
  visitor shared one address in the per-address limits and the sign-in pause.
- In production the session cookie is called `__Host-session_token`, which a browser accepts only
  from this exact host over https: another host under the same site can no longer set or shadow
  it. Existing sessions end once, at the update.
- A shared note can no longer draw over the rest of the share page — the page heading, the licence
  footer — with an overlay of its own: its content is contained to its box. Links in notes open in
  the same tab or a new one without an opener; the sign-in page shows only the messages the app
  itself sends, not any text put in its address.
- Protected routes check the session before reading the request body. Before, anyone without an
  account could make the API parse a body of up to 30 MB first, holding up every other request for
  seconds; the public share-view route now also takes at most 4 KiB.
- API responses default to `Cache-Control: no-store`, so the browser does not keep account data
  (including the wrapped Vault Key) or encrypted pulls in its disk cache after a sign-out.
- A refused request can no longer take a chunk set of an aborted restore back out of deletion, which
  let the storage it used be released from the account's usage twice.
- Two requests racing to create the first vault of a fresh instance can no longer both succeed.
- Production refuses a `TRUST_PROXY` range of `/0`, which trusts every peer just as `true` does.
- Following a link to another note no longer puts that note's title, in plain text, in the page
  address, where it reached the server's access logs, the `Referer` header of later requests and
  the browser history. Pages also send `Referrer-Policy: no-referrer`, so the address of the open
  note is not sent with the requests it makes.
- The API runs on Fastify 5.12.5, outside the range of CVE-2026-16732 (spoofed `X-Forwarded-*`
  headers under a hop-count `trustProxy`).
- `TRUST_PROXY` names the trusted proxies by address. Docker Compose defaults it to the subnet of a
  new `edge` network that only Caddy shares with the API. A hop count (`TRUST_PROXY=1`) is refused
  at startup, and so is `true` in production.
- Per-IP rate limits count an IPv6 client by its /64, so cycling through addresses in one
  allocation no longer buys a fresh quota.
- Failed sign-ins pause sign-in only from the source they came from. Before, one address that knew
  an email could keep that account locked indefinitely. A much higher account-wide threshold
  across all sources remains, and the sign-in page now says that a wrong password may also mean a
  short pause.
- The minimum response time of sign-in, registration and the password checks now holds: the wait
  used to happen only after the response had already been sent.
- Sign-in, registration and the password checks accept request bodies of at most 4 KiB.
- Production refuses to start with a `COOKIE_SECRET` or `KDF_FAKE_SEED` shorter than 32 characters,
  or with the example file's object-storage credentials, or with an `S3_ENDPOINT` that browsers
  cannot upload to from the app: a loopback address or a plain `http://` one.
- A share recipient's proofs for downloading an attachment travel in the request body
  (`POST /shares/:id/chunks/:fileId/:index`) instead of request headers, which reverse proxies
  write to their access logs. The `GET` form of the route is gone.
- Share pages send a single `Referrer-Policy: no-referrer`: the bundled Caddyfile now replaces the
  web container's policy instead of adding a second one that browsers applied instead, and the
  page carries the same policy as a meta tag for any other proxy.
