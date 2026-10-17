# Contributing to ZKnotes

Thanks for looking. This is a small project with one maintainer, so this file is mostly about
setting expectations honestly rather than laying down process for its own sake.

## Before you write code

**[Open an issue](https://github.com/zknotes/zknotes/issues) first for anything non-trivial.** A
pull request that changes behaviour, adds a dependency, or touches the crypto boundary is much more
likely to be merged if the approach was agreed before it was written. Small fixes — a typo, a clear
bug with a small diff — can go straight to a pull request.

Some changes will be declined regardless of quality, and it is fairer to say so up front:

- **Anything that weakens the encryption boundary.** Losing the password means losing the data. Key
  escrow, operator-triggered recovery, server-side search over plaintext, or "just decrypt it here
  for convenience" in UI code will not be accepted. If you think the threat model is wrong, open an
  issue arguing that — but a PR that quietly relaxes it will be closed.
- **Reaching around the crypto worker.** The Vault Key lives in a SharedWorker and item encryption
  goes through its RPC surface; the one other place it exists, a per-tab `sessionStorage` copy kept
  by `client/src/lib/core/crypto/session-key.ts`, is described under "Where keys live" in
  [`SECURITY.md`](SECURITY.md). Code that imports key material directly into a component is a
  security regression even when it works.
- **Adding a runtime dependency to do something small.** The dependency graph is part of the
  security surface of an end-to-end encrypted product.

## Running it

Everything you need is in [`README.md`](README.md): install, run, test. If a documented command does
not work on a clean checkout, that is a bug worth reporting on its own.

## Gates

Two checks have to pass before anything merges, and they are both scripts in this repository:

```bash
./check.sh    # security gate, formatting, linting, type checks, UI gates
./test.sh     # unit, integration and API tests
./test.sh --e2e-full   # the full browser suite, before merging anything user-visible
```

`./check.sh` writes formatting fixes rather than complaining about them, so run it before pushing
and commit what it changes.

There is a second gate you cannot run, and it is worth knowing about: the maintainer also builds the
private hosted service against the core, and a change can pass CI here and still fail there. That is
normal, and it is not a judgement on the change — it just means the two have to be reconciled before
the core is updated on the hosted side.

## Contributor License Agreement

**Contributions require a signed [CLA](.github/CLA.md) before they can be merged.** The first time
you open a pull request, a check comments on it with a link to the agreement. To sign, post exactly
this sentence, on its own, as a new comment on the pull request:

```
I have read the ZKnotes CLA version 1.1 and I hereby sign it.
```

Posting it signs the agreement, once, for this and every later contribution; the `CLA` check then
turns green. If the check does not update, comment `recheck`.

The person who opened the pull request and everyone who authored a commit in it have to sign, so
commit with an email address linked to your GitHub account (or your GitHub no-reply address) — the
check cannot match a commit to anyone otherwise. A co-author named in a `Co-authored-by:` line has
to sign too, and needs to be named by their GitHub no-reply address. Code pasted into an issue
cannot be used: send a pull request instead.

The reason is specific to how this project is built. ZKnotes is open core: the client and server in
this repository are AGPL-3.0-only, and the maintainer runs a hosted service that adds a private
administration layer in the same process. That combination is only defensible while the maintainer
holds the copyright to all of the core. Without a CLA, a single merged contribution would make that
arrangement legally doubtful, and it could not be undone afterwards — which is why the requirement
is enforced from the first pull request rather than introduced later.

Sending a patch is not itself an assignment of rights: nothing is merged until the CLA is signed.

## Style

- Code, identifiers, user-facing strings and test names are in **English**.
- TypeScript is strict; use `import type` for type-only imports.
- Formatting is Biome's job, not yours — `./check.sh` applies it.
- Commit messages follow Conventional Commits with a scope: `fix(client):`, `feat(server):`, `docs:`.
- Changes users would notice get an entry under `## [Unreleased]` in `CHANGELOG.md`, written in
  user-facing language rather than commit style.

## Security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Self-hosting support

Self-hosting is supported on a **best-effort** basis. The deployment files here are the ones the
maintainer actually uses, so they work, but there is no commitment to a response time on
self-hosting issues and no guarantee that every environment is catered for. Bug reports about the
application are welcome regardless of how you run it.
