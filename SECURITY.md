# Security policy

ZKnotes is an end-to-end encrypted notes application. Its central claim is that the server cannot
read your notes, so a vulnerability that breaks that claim is the most serious kind of bug this
project can have. Reports are welcome, including ones that turn out to be wrong.

## Reporting a vulnerability

Email **support@zknotes.eu** with `SECURITY` in the subject line. There is no separate security
alias; that address is the project's main contact channel.

Alternatively, use GitHub's private vulnerability reporting:
<https://github.com/zknotes/zknotes/security/advisories/new>. It stays private between you and the
maintainer until an advisory is published.

Please include enough to reproduce the issue — affected version or commit, what you did, what
happened, and what you expected. If you have a proof of concept, attach it or link to it. If the
report is sensitive and you want to encrypt it, say so in a first message without details and you
will get a key to use.

**Do not open a public issue for a vulnerability.** Anything that affects confidentiality of user
data should reach the maintainer before it reaches an issue tracker.

You will get an acknowledgement within a few days. This is a small project without a paid security
team, so please do not expect the response times of a large vendor — but every report about the
encryption boundary is read carefully.

## Supported versions

Security fixes go into the latest release only. Until 1.0 there are no backports to older releases:
a fix ships in the next release, and the way to get it is to update to that release (the update
path is in [`docker/README.md`](docker/README.md), §3).

## What the server sees

Encrypted on the device before anything is sent, so the server stores only ciphertext it cannot
read:

- note content and titles, folder names, and file names, descriptions and types;
- file contents, image thumbnails and image dimensions;
- icons, colours and the starred flag;
- the earlier versions kept in note history;
- the Vault Key and every Item Key, which the server holds only wrapped.

The search index is built on the device and kept there, encrypted; it never reaches the server.

Visible to whoever runs the server, because syncing, accounts and share links cannot work without it:

- for every item: whether it is a note, a folder or a file, its parent (so the shape of the folder
  tree, and which note each file is attached to), its position among its siblings, its version
  number, when it was created, last changed and moved to the trash, which items were trashed
  together — and with that, when and how often you edit;
- which items were deleted for good, and when (kept for two years, so that other devices learn of
  it);
- the size of each encrypted item and history entry; for a file, the number of encrypted chunks
  and their total size, from which its exact size follows, and that a conflict copy shares its
  original's chunks; the storage each account uses;
- the account's email address, when it was created and when it was last active (to within about
  five minutes), its KDF salt and parameters, and for each session the IP address and browser user
  agent it signed in from; failed sign-ins, by account and source address;
- **the password verifier**: an Argon2id hash of the Auth Key. Together with the salt and parameters
  it lets the operator try to guess a weak password offline, so the password is what protects the
  vault against the server — choose a long one. A share link's password is verified the same way;
- for a share link: which item and attachments it shares, when it was created, when it expires, how
  many views it allows and has had, when it was last viewed or revoked, whether it has a password
  and how many wrong ones were tried. The attachments of a shared note download through presigned
  object-storage URLs whose path contains the owner's account id, so a recipient can see that id;
- the SHA-256 of a backup file you restore from (for a backup without its own passphrase, that is a
  hash of the plaintext archive, so someone holding a copy of the file can confirm it is yours);
- usage analytics, unless the operator turns them off with `ANALYTICS_DISABLED`: which accounts were
  active on which day, and daily totals per route (listed under "Server-side analytics" in
  [`server/.env.example`](server/.env.example));
- error reports the app sends when a file preview fails (the error message and the file's id);
- like any web service, the IP address, timing, user agent and full address of every request — and
  the address carries the ids of the notes, files and share links involved.

## Where keys live

- **During sign-in, vault creation and a password change**, the page derives the Master Key, the
  Auth Key and the Encryption Key from the password on its main thread, sends only the Auth Key,
  uses the Encryption Key to unwrap (or wrap) the Vault Key, and wipes all of them when the call
  ends, failed or not. The Encryption Key never enters the crypto worker.
- **From then on the Vault Key lives in the crypto worker**, a SharedWorker that also holds the
  unwrapped Item Keys and does every encryption and decryption. The pages talk to it over messages,
  and the Vault Key never comes back out of it.
- **Each signed-in tab also keeps a copy of the Vault Key in its `sessionStorage`**
  (`client/src/lib/core/crypto/session-key.ts`), so that reloading the tab does not ask for the
  password again. Signing out removes it, and a copy left in another tab is refused after a sign-out.
  Closing a tab without signing out is different: browsers write `sessionStorage` into the profile
  on disk for session restore, and reopening a closed tab can bring the copy back.
- Script running on the app's origin can read that copy, as it could ask the unlocked worker to
  decrypt. That is why a way to run script on the origin is in scope below, and why the app's origin
  serves nothing but the code in this repository.

## Scope

In scope, and most valuable:

- Anything that would let a **server operator** read what [What the server sees](#what-the-server-sees)
  lists as encrypted, or learn more than it lists as visible.
- Weaknesses in key derivation, key wrapping, or the key hierarchy itself — password → master key →
  auth key / encryption key → vault key → item keys (summarised in
  [`shared/README.md`](shared/README.md)).
- The **Vault Key** reaching any storage other than the per-tab `sessionStorage` copy described in
  [Where keys live](#where-keys-live) — `localStorage`, IndexedDB, OPFS, Cache Storage, logs, the
  server — or that copy outliving a sign-out; the **Encryption Key** or **Master Key** outliving the
  sign-in or password change that derived them.
- Running script on the app's origin (cross-site scripting), through note content, a shared page or
  anything else.
- Ways to read another account's data, or to read a share link's content without its key.
- Authentication and session handling: fixation, token reuse after logout, privilege confusion.
- Anything that lets a served client differ from the published source in a way a user cannot detect.

Out of scope:

- Missing hardening headers or best-practice warnings with no described attack.
- Rate limiting on endpoints where the attack requires the correct password already.
- Denial of service through sheer volume against a self-hosted instance.
- Reports produced only by an automated scanner, with no analysis of whether the finding applies.
- The marketing website at zknotes.eu, which is a separate application and not part of this
  repository.

## What is not a vulnerability

**Losing the password means losing the data.** There is no recovery, no reset that preserves
content, and no key escrow. That is the design, not an oversight: a recovery path the operator can
trigger is a recovery path an attacker can trigger. Reports asking for account recovery are product
feedback, not security reports.

The same holds for anything that requires the user's own unlocked device or their master password,
or read access to the browser profile on disk, where the per-tab copy of the Vault Key and the
locally cached ciphertext live. An attacker who already has those is not a threat this design claims
to stop; protecting a device at rest is the job of its disk encryption.

**Changing the password does not replace the Vault Key.** It wraps the same Vault Key under a key
from the new password, so nothing else has to be re-encrypted. Someone who already holds the Vault
Key, taken from an unlocked device say, can still use it after the change. If you suspect that,
export a full backup (Settings → Backup & Export), delete the account, create a new vault and
restore the backup into it: restoring into an empty vault encrypts every item under new keys.

**Stopping a share cannot take back what was shared.** A share link carries the note's own Item
Key, and those of its attachments, wrapped under a key from the link. Stopping the share, or
replacing the link with a new one, makes the server refuse the old link. It cannot recall what a
recipient already opened or saved, and that includes the Item Key, which would also decrypt later
versions of the same note for anyone who got hold of their ciphertext.

**Sign-in throttling has a known limit.** Failed sign-ins pause sign-in to that account from the
source they came from (an IPv4 address or an IPv6 /64), for a delay that grows with each further
failure. A much higher account-wide threshold applies across all sources, and while it holds the
owner cannot sign in either. Both answer exactly like a wrong password, so neither reveals whether
the account exists. Reaching the account-wide threshold takes many sources at once; that this is
possible is a trade-off against distributed password guessing, not a vulnerability. A way to reach
it from a few sources, or to pause someone else's source, is.

## Disclosure

Report privately, give the maintainer a reasonable chance to fix the issue, and coordinate on timing.
If you want credit in the release notes, say so; if you prefer to stay anonymous, that is fine too.
