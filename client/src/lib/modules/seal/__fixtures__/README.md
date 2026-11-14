# Seal fixtures

Real OpenTimestamps data, captured once from the public calendars on 2026-11-13. The tests run
against these bytes offline. Nothing here is re-fetched by a test, and Biome does not reformat this
directory: every file is compared byte for byte.

| File | What it is |
|---|---|
| `sealed-file.txt` | The sealed file (105 bytes). |
| `manifest.json` | Its seal manifest: canonical JSON, keys sorted, no whitespace. |
| `capture.json` | `sha256(manifest.json)`, the 16-byte nonce, `commitment = sha256(digest ‖ nonce)`, and per calendar the message and URI of the pending attestation it returned. |
| `calendar-<name>.pending.bin` | The raw body of `POST <calendar>/digest` with `commitment` as the body: a bare timestamp rooted at the commitment. |
| `reference-merged.pending.ots` | The detached proof `digest → append(nonce) → sha256 → (all four replies merged)`, built and serialized with the reference Python library (`opentimestamps` 0.4.x, used as a test-vector generator only, never as a dependency). |
| `official.pending.ots` | `ots stamp manifest.json` from the official client v0.8.0 against the same four calendars. It uses the client's own nonce, so it is a separate tree from the capture above. |
| `calendar-<name>.upgrade.bin` | The raw body of `GET <calendar>/timestamp/<pending message>` once it returned 200: a bare timestamp rooted at that calendar's pending message, ending in a Bitcoin block attestation. |
| `reference-merged.confirmed.ots` | `reference-merged.pending.ots` with all four upgrades merged in, by the reference library. Blocks 975723 (alice, bob), 975735 (catallaxy), 975749 (finney). |
| `official.confirmed.ots` | `official.pending.ots` after `ots upgrade`; the client stops at the first complete path (block 975723). |

The confirmed proof was checked outside this code on 2026-11-14: `sha256sum sealed-file.txt` equals
`content_sha256`, and `ots --no-bitcoin verify manifest.json.ots` names a Merkle root for each block
that matches the root a public block explorer shows for it. Block 975723 was mined 53 minutes after
the seal; the last calendar's block came about 7.5 hours after it.

## How they were made

```bash
# the official client, in a throwaway virtualenv
uv venv ots-venv && uv pip install --python ots-venv/bin/python opentimestamps-client

# 1. pending: POST the commitment to each calendar and keep the raw body
#    (Accept: application/vnd.opentimestamps.v1)
# 2. the official proof
ots --no-cache stamp -m 4 \
  -c https://alice.btc.calendar.opentimestamps.org -c https://bob.btc.calendar.opentimestamps.org \
  -c https://finney.calendar.eternitywall.com -c https://btc.calendar.catallaxy.com manifest.json
# 3. confirmed: GET <calendar>/timestamp/<hex of the pending message> once it returns 200,
#    and `ots upgrade` on the official proof
```
