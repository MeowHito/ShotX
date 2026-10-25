# ADR 0006: One tmp/ lifecycle rule per prefix

- Status: Proposed
- Date: 2026-10-26

## Context

The platform spec says: "expire `tmp/` objects after 1–3 days", and infra had a single `tmp/` rule
of 1 day. Phase 3 puts three kinds of object under `tmp/` with different lifetimes:

- `tmp/index/`: face-index scratch JPEGs. The worker deletes them right after IndexFaces; the rule
  only removes what a crashed attempt left behind. They are face images, so shorter is better.
- `tmp/zips/`: finished zips. The API issues download URLs for `ZIP_RESULT_TTL_SECONDS` (default
  24 h) after `completed_at`. S3 dates a multipart object from when the upload was initiated, up
  to `WORKER_ZIP_MAX_PROCESSING_SECONDS` (2 h) earlier, and the last URL issued stays valid for
  `SIGNED_URL_DOWNLOAD_TTL_SECONDS` rounded up by `SIGNED_URL_EXPIRY_BUCKET_SECONDS`. That is
  94,500 s at the defaults, more than one day: a 1-day rule deletes zips that users can still
  download.
- `tmp/reconcile/`: the worker's reconciliation scan files (orphan face scans, quota scans). A
  scan must survive until a later run acts on it (the orphan grace is 3 h; a missed run adds a
  day), so a few days is too short to debug a failing reconciliation.

When lifecycle rules overlap, S3 applies the shortest expiration, so a longer zip lifetime can't
be added on top of a short `tmp/` rule.

## Decision

Replace the single rule with one rule per prefix, each a context value in `infra/cdk.json`:

| prefix           | default | range |
| ---------------- | ------: | ----: |
| `tmp/index/`     |   1 day |   1–3 |
| `tmp/zips/`      |  2 days |  1–30 |
| `tmp/reconcile/` |  7 days |  1–30 |
| `tmp/` (rest)    |  7 days |  1–30 |

Synth checks that `tmp/zips/` covers
`WORKER_ZIP_MAX_PROCESSING_SECONDS + ZIP_RESULT_TTL_SECONDS + SIGNED_URL_DOWNLOAD_TTL_SECONDS +
SIGNED_URL_EXPIRY_BUCKET_SECONDS` (each the larger of api's and worker's value), and that the
`tmp/` catch-all is at least as long as every specific rule, so it never shortens one.

`tmp/reconcile/` has no constant in packages/shared yet; infra derives it as
`${S3_PREFIXES.tmp}reconcile/` (`TMP_RECONCILE_PREFIX`). It should move to `S3_PREFIXES`.

## Consequences

- `tmp/zips/` (2 days) stays inside the spec's 1–3 days; `tmp/reconcile/` and the catch-all (7
  days) go beyond it. Neither holds biometrics or user media: scan files carry ids and counts
  only. The worker must not write face images or selfies there.
- Raising `ZIP_RESULT_TTL_SECONDS` (up to 3 days) fails synth until `tmpZipsExpirationDays` is
  raised with it.
- The DPO reviews the reconcile retention together with the other retention periods.

## Alternatives

- **Keep one `tmp/` rule at 2–3 days.** Face-index scratch images would live longer than needed,
  and reconcile scans would still be cut at 3 days.
- **Delete zips from the worker on a schedule.** More code and IAM (`DeleteObject` on
  `tmp/zips/`) for what a lifecycle rule does for free.
