# ADR 0004: Temporary index image keys per attempt and part

- Status: Accepted
- Date: 2026-10-25

## Context

The platform spec says the worker indexes faces from a temporary JPEG written to
`tmp/index/{fileId}.jpg` and passed to Rekognition as an S3 object. That key has two problems:

1. **Concurrent attempts share it.** SQS delivers at least once, and a message whose visibility
   timeout runs out while the worker is still waiting on the Rekognition rate limiter is delivered
   again. Two attempts for the same file then write, read and delete the same key. One attempt can
   delete the image while the other's `IndexFaces` call is about to read it, or index the other
   attempt's encoding.
2. **Tiles have no key.** For group shots the worker also indexes 2×2 overlapping tiles (spec,
   "Face indexing"). Each tile is its own image and needs its own key. face-poc's current code
   appends `-t{n}` to the file id, which still collides across attempts.

## Decision

Temporary index images use

```
tmp/index/{fileId}/{attemptId}/{part}.jpg
```

- `attemptId` is unique per indexing attempt (the worker generates it, e.g. a UUID). It is a safe
  key segment: 1–128 characters from `[A-Za-z0-9_-]`.
- `part` is `full` for the whole photo, or `t{n}` for tile `n` (0-based, the same index the face
  package reports as the face's tile; 0–999).

The key is built only with `indexImageKey({ fileId, attemptId, part })` from `@shotx/shared`
(`indexTilePart(n)` makes `t{n}`), and `parseS3Key` recognises it. Nobody writes these keys by hand.

## Consequences

- Concurrent attempts for one file never touch each other's images, and every tile has a key.
- Still under `tmp/`, so the bucket's `tmp/` lifecycle rule (1–3 days) removes anything an attempt
  leaves behind, and the worker's IAM grant on `tmp/*` already covers it. infra needs no change.
- `tmp/index/{fileId}/` groups all attempts for a file, so a cleanup can delete by that prefix
  (`indexImagePrefix(fileId)`).
- face-poc moves `indexPhoto` from `${tempKeyPrefix}${fileId}${suffix}.jpg` to `indexImageKey`.
  Until then its keys stay under `tmp/index/` and remain covered by the lifecycle rule.

## Alternatives considered

- **Keep `tmp/index/{fileId}.jpg` and lock per file in Redis.** Adds a lock with its own expiry
  and failure modes to protect a temporary file, and still gives tiles no key.
- **Send images inline instead of through S3.** Rekognition accepts at most 5 MB inline, while
  index images may be up to 15 MB (long edge ~3,500 px, quality 90). The inline path stays for
  smaller images, but the S3 path needs keys.
