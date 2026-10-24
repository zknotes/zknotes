# Verifying the build

ZKnotes is zero-knowledge: your notes are encrypted in the browser, and the server only ever sees
ciphertext. That claim rests on the code running in your browser — the code that receives your
password and derives your keys. Publishing the source does not, by itself, prove that a server sends
you that source. A server could send one visitor, or everyone, something else.

This document describes what you can check yourself, how, and — just as important — what a
successful check does **not** tell you.

## The idea

The web client builds **reproducibly**: the same commit, built with the same two inputs, produces a
byte-identical set of files, wherever it is built. That turns "which code is this server sending?"
into a comparison anyone can make:

1. The instance names the commit it was built from — in **Settings → About**, and at
   `/_app/version.json`.
2. You build that commit yourself, from a clone of this repository.
3. You fetch every file the instance serves and compare it with your build.

The references are the public repository and your own machine. Nothing the instance serves is
trusted as a reference; it is only compared.

## Quick check: does the commit build reproducibly?

Every push to `main` runs [`scripts/verify-reproducible.sh`](../scripts/verify-reproducible.sh) in
the public CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml), job *Builds from this
repository alone*). It builds the web image twice from `git archive`, without the layer cache,
requires the two web roots to be identical, and writes the resulting **treeHash** to the job summary
under *Reproducible web build*. A third build, in a plain container from a full checkout, has to give
the same hash — so the hash depends on the source and the two inputs, not on how the source was
handed over.

To look one up: take the commit from Settings → About (or `/_app/version.json`), open that commit's
CI run on GitHub, and read the treeHash from the job summary. That tells you the commit builds
reproducibly and what its hash is. It does **not** yet tell you what the server sends — that needs
the full check.

The summary exists for a push whose run completed. A run that a later push cancelled, or a commit
that reached `main` inside a push of several, has none — then
`scripts/verify-reproducible.sh <sha>` on your own machine gives the hash, and it is the same
number.

## Full check: does the instance serve that commit?

Prerequisites: `bash`, `git`, `docker`, `curl`, `tar` and `sha256sum` (on macOS:
`brew install coreutils`), and about five minutes — the client is built once, in Docker, and then
fetched file by file.

```bash
git clone https://github.com/zknotes/zknotes.git
cd zknotes
scripts/verify-live.sh https://notes.example.com
```

[`scripts/verify-live.sh`](../scripts/verify-live.sh):

- reads `/_app/version.json` and takes the commit from it (`--commit <sha>` builds another one
  instead; the served `version.json` is still compared, so a different commit cannot match);
- fetches the commit from the public repository if your clone does not have it — a commit that
  cannot be fetched is itself a finding;
- builds it in the canonical environment (the builder stage of
  [`docker/Dockerfile.web`](../docker/Dockerfile.web), pinned by digest), through the same
  [`scripts/lib-build-web.sh`](../scripts/lib-build-web.sh) that CI and the reproducibility check use;
- requests every file of that build from the instance, without compression and without following
  redirects, and compares the bytes. It also requests `/` and a fixed set of paths a browser opens
  as a document — `/login`, `/create-vault`, `/settings`, a share link, a note, a trailing slash
  and one random path — because a browser gets the shell from whatever address it was opened at,
  and the server answers each of them with `index.html`; every one has to be the built
  `index.html`. The requests carry a browser's `User-Agent`, `Accept` and `Sec-Fetch-*` headers,
  which removes the cheapest way to tell the script from a visitor — not every way, see below;
- prints the commit, its date, whether it is on `origin/main`, the treeHash of your build (the same
  number CI publishes for that commit), `match=N/N` over the files, `/` and the routes, and every
  file or route that differs, is missing, or answered with another status; a request that failed
  is listed separately.

Exit codes: `0` — every file, `/` and every route are byte-identical; `1` — a difference, a missing
file or route, or a commit the public repository does not hand out; a difference wins over a failed
request, so a run with both exits `1` and lists the failed requests separately; `2` — the instance
cannot be checked (its version is not a commit hash, or the address is not the instance root) or an
environment error (a missing tool, no network, no `origin` remote in your clone, a redirect, or a
request that failed while nothing else differed).

An instance whose `version.json` holds a build timestamp instead of a commit was built without
`APP_COMMIT`. There is no commit to rebuild, so it cannot be verified — the script says so and exits
with `2`. The operator builds with the two inputs described in
[`docker/README.md`](../docker/README.md) ("Updating") to make it checkable. On an instance that
says it can be verified, a version that is not a commit is itself worth a question; `--commit <sha>`
forces the comparison, and the served `version.json` is then compared as a file.

## What a match means

Every file the instance sent you, at the moment you asked, is byte for byte the file your own build
of that public commit produced, and every address the app is opened at answered with that built
shell. No file your browser loads was changed or removed on the way from the repository to the
script. A file the server *adds* is not listed — the script enumerates its own build, not the
server's — but nothing in the verified files loads a name that is not in the build, so such a file
would sit there unloaded.

## What a match does not mean

Being honest about the limits is the whole point of this document. A successful run does **not**
prove:

- **That everyone gets the same answer.** The check sees what was sent to *this script*, from *your*
  address, at *that* moment. The requests are made by `curl` wearing a browser's headers, and a
  server can still tell the two apart — by the TLS fingerprint, among other things — and send honest
  bytes to every verifier while browsers get something else. A server that targets one visitor, one
  kind of client, or switches builds later, is not caught unless the check is made from that
  position at that time.
- **That the commit is the one you expect.** The server chooses which commit it serves. A match says
  it serves an unmodified build of *that* public commit; it may be an old one. The script prints the
  commit's date and whether it is on `origin/main` — check that it is the commit you would expect a
  current instance to run.
- **Anything about the HTTP headers**, the Content-Security-Policy among them. Only file contents are
  compared. [`scripts/smoke-headers.sh`](../scripts/smoke-headers.sh) checks a few headers, but it
  is a smoke test, not a verification.
- **What your browser is actually running.** The script fetches with `curl`. Your browser may run an
  older version from its service worker cache ([`client/src/service-worker.ts`](../client/src/service-worker.ts)),
  and a browser extension or a compromised machine can change the code after it arrives. None of that
  is on the wire the script looks at.
- **Anything about the server side.** The API that stores your ciphertext, the database, the object
  storage — this check covers the files served to the browser and nothing else. The zero-knowledge
  design is what makes the server side matter less; it is not what this check verifies.
- **That a local `vite build` under Node matches.** The claim holds for the digest-pinned Bun builder
  image in `docker/Dockerfile.web`: Vite turns some of its own functions into source text at build
  time, and Bun transpiles modules as it loads them, so the JavaScript runtime is an input to the
  bytes. Build in Docker — the script does.

The browser itself does not yet refuse a changed file: there is no per-file integrity enforcement
beyond the CSP hash of the inline bootstrap script. That is a later step, not this one.

## The pieces, and what each one proves

| Piece | Proves |
|---|---|
| [`scripts/tree-hash.sh`](../scripts/tree-hash.sh) | One definition of **treeHash**: a single sha256 over every file's path and content in a web root. Two web roots with the same treeHash serve the same bytes. Every other script calls this file rather than repeating the pipeline. |
| [`scripts/lib-build-web.sh`](../scripts/lib-build-web.sh) | The one function that builds a web root from a tree (`git archive` → `docker build --no-cache` → copy the web root out of the image). Both checks below build through it. |
| [`scripts/verify-reproducible.sh`](../scripts/verify-reproducible.sh) | The same commit, built twice in separate directories, gives the same treeHash. `--self-test` changes one input for the second build and must see a difference — proof that the comparison measures something. |
| CI job *Builds from this repository alone* | Runs the above on every push and publishes the treeHash — a record kept by GitHub rather than by the operator. Also proves the repository builds with nothing private: a dependency outside the repository fails the job. |
| [`scripts/verify-live.sh`](../scripts/verify-live.sh) | A running instance serves exactly the build of the commit it names. |

The inputs to a build, and the only ones: the committed tree (filtered by
[`.dockerignore`](../.dockerignore)), `APP_COMMIT` (the full commit hash, which names the version) and
`SOURCE_DATE_EPOCH` (the commit's timestamp, used instead of the clock). The checkout path, the
number of CPUs, the locale, the time zone and the instance's `.env` do not reach the bytes; the
instance's own addresses arrive at runtime from `/instance-config`, not at build time.

## When it does not match

1. **Run it again.** A request that failed is reported as such; when nothing else differed, the
   script exits with `2` — a network error, not a finding. A difference next to a failed request
   still exits with `1`.
2. **Look at the file it names.** The script prints the expected and the served hash. Fetch the file
   (`curl -H 'Accept-Encoding: identity' <url>/<path>`) and compare it with the one in your build
   with [diffoscope](https://diffoscope.org/) — it shows *what* differs, not just that it does.
3. **A missing file** ("the server answered with the SPA shell") means the instance serves a build
   that lacks a file yours has — usually a different commit than it claims, or a partial deploy.
4. **An old commit** is not a mismatch, but worth asking the operator about.
5. **A route that differs** (`/login (route → index.html)`) means the server answers that address
   with something other than the built shell — the most direct way to hand a visitor different
   code. Treat it as the next point. A route that *redirects* is reported as such: a browser
   opening that address would not get the shell from there.
6. **If the served code differs from the public commit it claims**, treat it as a security issue:
   keep the files, note the time and your network, and report it as [`SECURITY.md`](../SECURITY.md)
   describes. Do not sign in to that instance until it is explained.

## For operators

An instance is checkable when it is built with the two inputs — `APP_COMMIT=$(git rev-parse HEAD)`
and `SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)` — which `docker/setup.sh` and the commands
in [`docker/README.md`](../docker/README.md) do. Set `VERIFY_URL` in the API's environment
([`server/.env.example`](../server/.env.example)) to a page that tells your users how to run the
check, and Settings → About shows a *Verify this build* link next to the commit; leave it unset and
no link is shown.
