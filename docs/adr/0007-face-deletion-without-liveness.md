# ADR 0007: Face deletion without liveness (MVP accepted risk)

- Status: Accepted (the user approved the MVP scope). The company's DPO must review this risk
  before launch, together with the consent texts and retention periods.
- Date: 2026-10-26

## Context

The PDPA checklist requires a public "ขอลบใบหน้าของฉัน" flow: a person scans their face on a share
page and their matched faces are deleted from that photographer's Rekognition collection
(`POST /s/:token/face-deletion`). The Phase 3 review found two gaps:

- The flow was gated like face search: it failed with FEATURE_DISABLED when
  `FACE_SEARCH_ENABLED=false`, and with SHARE_EXPIRED, LOGIN_REQUIRED or PASSWORD_REQUIRED on
  revoked, expired, login or password shares. A data-subject right must not depend on a feature
  flag or on the photographer keeping a link open.
- Nothing proves that the selfie shows the person who sends it. The spec plans Rekognition Face
  Liveness only for Phase 6 (with `face_only` mode).

## Decision

1. Face deletion is gated only on the token (an unknown token is NOT_FOUND) and on a current
   consent with purpose `face_deletion` for this share and viewer or session (CONSENT_REQUIRED).
   It never answers FEATURE_DISABLED, SHARE_EXPIRED, LOGIN_REQUIRED or PASSWORD_REQUIRED.
2. Consent has a purpose (`consents.purpose`: `face_search` | `face_deletion`). Each purpose has
   its own Thai text per policy version. Giving a `face_deletion` consent has the same token-only
   gate, so it works with the flag off. Giving a `face_search` consent keeps every share gate
   and the flag. `CONSENT_PURPOSE_GATES` in `@shotx/shared` encodes both.
3. A new route, `GET /s/:token/face-deletion` (token only), gives the deletion page the current
   policy version, the consent state and the selfie settings, because `GET /s/:token` fails on
   unavailable shares.
4. Deletion ships without liveness. Rate limits, an alert and the planned Face Liveness work
   mitigate the risk.

## The accepted risk

Anyone who has a photo of a person (from social media, or a screenshot of the event gallery) can
submit it and delete that person's faces from the photographer's collection. The person then
stops finding their photos by face search in that photographer's shares until the photos are
indexed again. No photos are deleted, and nothing about the matched photos is returned (the
response is a count only), so the attack can't reveal where someone appears. It removes
biometric data, which is the direction PDPA favours. The damage is lost search recall for the
victim, and the photographer's support load.

## Mitigations

- **Request limits.** Deletion counts against the face-search limits per IP, per share and per
  viewer (`FACE_SEARCH_RATE_*`, enforced in Redis, failing closed per ADR 0005), and the WAF's
  rate rules and CAPTCHA cover `/api/s/*/face-deletion` like face search.
- **High threshold.** Only direct matches at or above `FACE_DELETION_THRESHOLD` (default 95) are
  deleted, without expansion, so one selfie removes one person's faces, not look-alikes.
- **Alert per share.** After recording a deletion, the API counts the share's `face_deletions`
  within `FACE_DELETION_ALERT_WINDOW_SECONDS` (default 1 day). At
  `FACE_DELETION_ALERT_PER_SHARE` (default 20) or more it logs `face_deletion.alert` (share,
  owner, count; no biometrics), and infra raises a CloudWatch alarm on it.
- **Audit trail.** `face_deletions` keeps counts per request (share, photographer, time), so
  operators can see a burst and its scope.
- **Face Liveness in Phase 6.** Rekognition Face Liveness becomes a requirement for deletion
  once it exists for `face_only` mode. When that happens, this ADR is superseded.

## Alternatives considered

- **Require liveness now.** Rejected for the MVP: Face Liveness needs its own client SDK flow,
  session API and testing, and the in-app browsers of LINE and Facebook often block the camera.
- **Manual review of deletion requests.** Rejected: it delays a data-subject right, needs an
  operator queue that Phase 5 doesn't have yet, and makes staff look at biometric data.
- **Keep the share gates and the flag on deletion.** Rejected: it blocks a PDPA right whenever
  the photographer revokes or expires the link, or the operator turns face search off.

## Consequences

- api: the deletion route, its info route and the `face_deletion` consent skip availability,
  login, password and flag checks. Face search and its consent keep them.
- worker: `delete.faces` runs whatever the flag (already true for expiry, unindexing and
  reconciliation).
- web: the share page and the "ลิงก์นี้หมดอายุ" page always link to the deletion flow, which reads
  `GET /s/:token/face-deletion` and shows the `face_deletion` consent text.
- infra: an alarm on the `face_deletion.alert` log event, and the WAF rules on face deletion.
- DPO: reviews this risk and both consent texts before launch.
