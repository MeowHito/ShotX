# ADR 0006: One tmp/ lifecycle rule per prefix

- Status: Accepted
- Date: 2026-10-26 (proposed); amended and accepted 2026-10-26

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
- `tmp/reconcile/`: the worker's reconciliation scan files (`faces.reconcile.daily`). A scan is
  written by one run and acted on by a later run once `FACE_ORPHAN_GRACE_MS` (3 h default, 1 day
  at most) has passed.

When lifecycle rules overlap, S3 applies the shortest expiration, so a longer zip lifetime can't
be added on top of a short `tmp/` rule.

The first version of this ADR (Proposed) kept `tmp/reconcile/` and the catch-all at 7 days, beyond
the spec. The main session decided to stay inside the spec's 1–3 days for every `tmp/` rule.

## Decision

One rule per prefix, each a context value in `infra/cdk.json`, every one within 1–3 days
(`TMP_LIFECYCLE_MAX_DAYS = 3` in packages/shared):

| prefix           | default | range |
| ---------------- | ------: | ----: |
| `tmp/index/`     |   1 day |   1–3 |
| `tmp/zips/`      |  2 days |   1–3 |
| `tmp/reconcile/` |  3 days |   1–3 |
| `tmp/` (rest)    |  3 days |   1–3 |

Synth checks that:

- `tmp/zips/` covers `WORKER_ZIP_MAX_PROCESSING_SECONDS + ZIP_RESULT_TTL_SECONDS +
SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS` (each the larger of api's
  and worker's value). packages/shared caps `ZIP_RESULT_TTL_SECONDS` at 2 days and its loader
  refuses any combination that would exceed 3 days with the 11 h worker cap
  (`ZIP_OBJECT_MAX_AGE_SECONDS`), so every valid configuration has an answer of at most 3 days.
  At the defaults it needs 2.
- `tmp/reconcile/` covers one `FACE_ORPHAN_GRACE_MS` plus one daily run: 2 days at the default
  grace and at the 1-day maximum. 3 days leaves a missed run of margin.
- the `tmp/` catch-all is at least as long as every specific rule, so it never shortens one.

`tmp/reconcile/` has no constant in packages/shared yet; infra derives it as
`${S3_PREFIXES.tmp}reconcile/` (`TMP_RECONCILE_PREFIX`). It should move to `S3_PREFIXES`.

### Why these values

- `tmp/index/` 1 day: face images, the shortest S3 allows.
- `tmp/zips/` 2 days: the smallest rule that keeps every downloadable zip at the defaults.
- `tmp/reconcile/` 3 days: scans only need to survive one grace period plus one daily run (at most
  2 days); a longer retention for debugging failing reconciliations is not worth leaving the
  spec's range. A lost scan only delays orphan deletion by a day: the next run scans again.
- catch-all 3 days: the longest per-prefix rule.

## Consequences

- Every `tmp/` object is gone within 3 days (S3 expires at the first midnight UTC after the age),
  as the spec says. Neither reconcile scans nor anything else under `tmp/` outlives that.
- Raising `ZIP_RESULT_TTL_SECONDS` past what 2 days covers fails synth until
  `tmpZipsExpirationDays` is raised to 3; nothing can need more than 3.
- The worker's comment in `apps/worker/src/jobs/orphan-scans.ts` still says "a 7-day lifecycle
  rule"; the worker owner updates it. The behaviour doesn't change: the next run reads the scan
  within 24 h.
- The DPO reviews these retention periods together with the others.

## Alternatives

- **Keep one `tmp/` rule at 2–3 days.** Face-index scratch images would live longer than needed.
- **Keep `tmp/reconcile/` at 7 days (the Proposed version).** Easier debugging, outside the spec.
- **Delete zips from the worker on a schedule.** More code and IAM (`DeleteObject` on
  `tmp/zips/`) for what a lifecycle rule does for free.
