# @shotx/face

Face indexing and face search behind the `FaceProvider` interface (ADR 0001). Production uses
`RekognitionFaceProvider`; tests and the evaluation harness use `FakeFaceProvider` from
`@shotx/face/testing`. Every tunable comes from `FaceConfig` (`loadFaceConfig` in
`@shotx/shared`); only fixed Rekognition API limits are constants here.

Consumers: `apps/api` (face search, interactive profile), `apps/worker` (indexing, purges,
reconciliation, background profile) and `tools/face-eval`.

## Building the provider

```ts
const face = loadFaceConfig(process.env);
const limiters = createRedisRekognitionLimiters(redis, face.rekognition, 'background');
const provider = RekognitionFaceProvider.create(
  face.rekognition,
  'background',
  limiters,
  loadRekognitionClientConfig(process.env), // @shotx/shared, ADR 0008 section 1
);
```

The api passes `'interactive'` for both. The client config gives the client its region, its
endpoint (`REKOGNITION_ENDPOINT_URL`, set only for tests and LocalStack) and its keys
(`REKOGNITION_ACCESS_KEY_ID` / `REKOGNITION_SECRET_ACCESS_KEY`, required off AWS). Each is passed
to the SDK only when configured (`rekognitionSdkConfig`): no endpoint means Rekognition's
regional endpoint, no keys means the default chain, which is only right on the AWS stacks (the
task role). The shared loader refuses `AWS_ENDPOINT_URL` off AWS, because the SDK would apply it
to a client without an explicit endpoint. `create` turns off the SDK's own retries (the provider
retries behind the rate limiters) and bounds every request by
`FACE_REKOGNITION_REQUEST_TIMEOUT_MS` in two places:

- the SDK request handler gets it as its connection timeout and as a request timeout that fails
  the request (`throwOnRequestTimeout`), and
- the provider aborts each `client.send` after it, which also covers what the handler's timer
  doesn't: credential resolution and a response body that stops arriving after the headers.

A request that times out fails with `RekognitionRequestTimeoutError` (name `TimeoutError`).
Calls that are safe to repeat retry it like any other transient error. IndexFaces doesn't: the
request may have reached Rekognition, so a timeout ends the call with
`IndexFacesOutcomeUnknownError`.

## Images go as bytes (ADR 0008 section 5)

Every image reaches Rekognition as `Image.Bytes`, whose limit is 5 MiB (5,242,880 bytes,
`REKOGNITION_INLINE_MAX_BYTES`). Nothing is written to storage: the S3Object path, the temporary
index images under `tmp/index/` and the `TempImageStore` adapters are gone.

- `indexPhoto` encodes the full photo and every tile in memory with `encodeJpeg` under
  `FACE_INDEX_MAX_BYTES` (default and maximum 5 MiB), capped at the provider's limit. The loop
  lowers JPEG quality by `FACE_ENCODE_QUALITY_STEP` down to `FACE_ENCODE_MIN_QUALITY`, then
  shrinks the long edge by `FACE_ENCODE_SHRINK_FACTOR`, trying `FACE_ENCODE_MIN_LONG_EDGE` itself
  last. FaceConfig only accepts a limit that a square image of that edge fits at any quality, so
  the loop always lands. Each photo decodes once per size, not once per quality step.
- `IndexPhotoResult.images` reports every image sent (tile, bytes, size, quality used, whether it
  was downscaled). face-eval aggregates it; the worker may log counts from it.
- `RekognitionFaceProvider` refuses images above the limit with `ImageTooLargeError` before it
  takes a rate-limit token or sends anything, for IndexFaces and selfies alike, and
  `FakeFaceProvider` enforces the same limit.
- Noisy photos (high ISO, foliage, crowds) that went at quality 90 under the old 15 MiB S3 limit
  now go at a lower quality; `src/encode-limit.test.ts` covers pure-noise worst cases for full
  images and tiles. `tools/face-eval` measures what that does to accuracy.

## Rate limits: what the token bucket guarantees

`RedisTokenBucket` (shared by every api and worker instance) never hands out more than
`FACE_REKOGNITION_TPS_<OPERATION>` **reserved slots** in any sliding second. It says nothing
about when requests actually reach AWS: a request starts at its slot plus sleep lateness, plus
signing and sending, and arrives after network latency that varies per request. Two calls in
adjacent slots can arrive closer together than their slots, so Rekognition can still see more
than the configured TPS in some second and throttle one. That is why:

- the provider still retries `ThrottlingException` with jittered backoff (each retry takes a new
  slot), and IndexFaces retries only throttling;
- the `FACE_REKOGNITION_TPS_*` values should stay a little under the account's quotas.

`ListFaces` has its own bucket and rate (`FACE_REKOGNITION_TPS_LIST_FACES`).

## Worst-case durations

`rekognitionCallWorstCase(config.rekognition, profile)` and
`indexPhotoWorstCase(config, { previousFaces })` compute these from the configuration in use.

One provider call (one IndexFaces, or one DeleteFaces batch of up to 4,096 ids) makes up to
`maxAttempts` attempts. Each attempt waits up to `maxWaitMs` for its rate-limit slot (a longer
wait fails at once with `RateLimitedError`, which is not retried) and then runs for up to
`requestTimeoutMs`. Between attempts it backs off for less than
`min(retryMaxMs, retryBaseMs × 2^(n−1))` after attempt n:

```
perCallMs = maxAttempts × (maxWaitMs + requestTimeoutMs) + Σ_{n=1}^{maxAttempts−1} min(retryMaxMs, retryBaseMs × 2^(n−1))
```

One `indexPhoto` attempt makes `1 + FACE_TILE_GRID²` IndexFaces calls and DeleteFaces batches for
`previousFaceIds` (re-index only), for faces cut off at inner tile edges, and, when anything
fails, for the rollback of every face the attempt indexed:

```
attemptMs = (indexFacesCalls + deleteFacesCalls) × perCallMs
```

At the defaults:

|                                              | Value                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| One background call                          | 8 × (30,000 + 10,000) + 22,600 = **342,600 ms** (5 min 42.6 s) |
| One interactive call (api)                   | 3 × (2,000 + 10,000) + 300 = **36,300 ms**                     |
| First indexing: 5 IndexFaces + 2 DeleteFaces | 7 × 342,600 = **2,398,200 ms** (about 40 min)                  |
| Re-index: 5 IndexFaces + 3 DeleteFaces       | 8 × 342,600 = **2,740,800 ms** (about 45.7 min)                |
| Smallest grace for that (2 × attempt)        | 4,796,400 ms first indexing, **5,481,600 ms** re-index         |

Not included, because the provider doesn't bound them: the Redis round trip of each
reservation, timers firing late, and the work around the calls (decoding and encoding the image
and its tiles, the local detector, database writes). Measure those and
add a margin. CreateCollection/DescribeCollection, if the job makes sure the collection exists,
are two more calls.

**Two bounds, one gate.** These numbers (`worst-case.ts`) are the tighter in-process estimate:
they follow the exact backoff caps and count only the calls `indexPhoto` makes.
`facesJobWorstCase` in `infra/lib/face-limits.ts` is the stricter bound and **the deployment
gate**: it charges `retryMaxMs` for every backoff (8 × 40,000 + 7 × 10,000 = 390,000 ms per call),
counts 10 calls per job (collection calls and DeleteFaces batches included) and adds 60 s of
processing, so 10 × 390 s + 60 s = **3,960 s** at the defaults. Infra's synth refuses a
configuration whose `FACE_ORPHAN_GRACE_MS` is below 2 × that (7,920,000 ms).

The default `FACE_ORPHAN_GRACE_MS` is 10,800,000 ms (3 hours), which passes both: above
infra's 7,920,000 ms and above the 5,481,600 ms re-index estimate here. If you change
`FACE_REKOGNITION_MAX_WAIT_MS`, `FACE_REKOGNITION_MAX_ATTEMPTS`,
`FACE_REKOGNITION_REQUEST_TIMEOUT_MS` or the tile settings, infra's check decides whether the
grace still fits; `indexPhotoWorstCase` is for in-process checks and logs.

## Deleting orphaned faces safely (worker)

An orphan is a face in a photographer's collection (`pg-{photographerId}`) that no `faces` row
tracks. Purges and face-index expiry delete only the face ids they find in rows, so an orphan
would never expire. Orphans come from failed indexing attempts whose cleanup failed too, from
IndexFaces calls that indexed faces without returning them (timeouts, 5xx, dropped
connections), and from workers that die between IndexFaces and the insert.

A face that an attempt has indexed but not committed yet looks exactly like an orphan.
`reconcileCollection` tells them apart only if the worker keeps every rule below.

### 1. Commit an attempt's rows before its deadline, or never

```ts
const startedAt = Date.now(); // before indexPhoto, not after
const result = await indexPhoto(deps, original, indexPhotoOptions(face, target));
await db.transaction(async (tx) => {
  // ... replace the file's faces rows, update files.face_count ...
  if (Date.now() > recordFacesDeadline(startedAt, face.index.orphanGraceMs)) {
    throw new DeadlineMissed(); // rolls the transaction back
  }
});
```

- Take `startedAt` **before** calling `indexPhoto`: every face of the attempt is indexed after
  it.
- Check the deadline inside the transaction, right before the commit. The deadline is half the
  grace; the other half covers commit latency, replica lag and clock differences between hosts.
- When the deadline has passed, don't commit. Delete the attempt's faces
  (`provider.deleteFaces(collectionId, result.faces.map((f) => f.faceId))`) or leave them to
  reconciliation, and let the job retry with a new attempt.

### 2. Grace of at least 2 × the longest attempt

`FACE_ORPHAN_GRACE_MS` (`config.index.orphanGraceMs`) must be at least twice the longest
`indexPhoto` attempt, so a slow but healthy attempt still commits before its deadline. The
deployment gate is infra's synth check (2 × `facesJobWorstCase`, see above). The worker can add
the tighter in-process estimate as a start-up sanity check:

```ts
const maxFacesPerFile = (1 + face.index.tileGrid ** 2) * face.index.maxFaces;
const worst = indexPhotoWorstCase(face, { previousFaces: maxFacesPerFile });
if (face.index.orphanGraceMs < worst.minOrphanGraceMs + 2 * measuredProcessingMs) {
  logger.error('FACE_ORPHAN_GRACE_MS is shorter than 2 × the longest indexing attempt');
}
```

The faces queue's visibility timeout (900 s) is shorter than one worst-case job, so the worker
heartbeats with ChangeMessageVisibility every timeout/3 while a job runs; `facesJobWorstCase` in
`infra/lib/face-limits.ts` bounds how long that can go on.

### 3. Read `knownFaceIds` from the primary

`knownFaceIds(faceIds)` answers "which of these ids have a `faces` row" for the scan and again
right before each delete. Query the **primary** database, never a read replica: a lagging
replica makes a just-committed face look orphaned, and it would be deleted.

### 4. Handle `IndexPhotoError`

Every `indexPhoto` failure is an `IndexPhotoError`; `cause` says why. It has already tried to
delete the faces it indexed. What it reports as left behind:

- `orphanFaceIds`: faces still in the collection because that delete failed too. No row tracks
  them. Retry `provider.deleteFaces(error.collectionId, error.orphanFaceIds)` (ids that are
  already gone are ignored), or leave them to reconciliation. Never insert rows for them.
- `untrackedFacesPossible`: an IndexFaces call ended with `IndexFacesOutcomeUnknownError`, so
  faces may exist whose ids nobody knows. Only `reconcileCollection` finds them; it runs daily
  anyway, so there is nothing else to do beyond logging it.
- `cleanupErrors`: every cleanup step that failed after `cause` (DeleteFaces), for logs. Log
  error names and counts only, never image bytes.

After an `IndexPhotoError` the job may retry: the next attempt has a new attempt id.

### 5. Pass `previousFaceIds` when re-indexing

When a file already has `faces` rows (re-indexing, or an `index.file` message delivered again
after a commit), pass their `rekognition_face_id` values as `previousFaceIds`. `indexPhoto`
deletes them before it indexes anything, so if that delete fails the rows still track every
face. After success, replace the file's rows in one transaction (rule 1 applies). Rows left
pointing at already-deleted faces are harmless: searches never return those faces and deleting
them again is a no-op. Alternatively, skip files that already have rows.

### 6. Run `reconcileCollection` from `faces.reconcile.daily`

The `faces.reconcile.daily` scheduled job reconciles each photographer's collection with
`graceMs: face.index.orphanGraceMs` and the primary-database `knownFaceIds`. It is safe to rerun:
deleting a face that is already gone is a no-op, and `OrphanCleanupError` reports how far a
failed run got.

`reconcileCollection` scans, then **sleeps until the grace after the scan has passed** before
deleting (only when there are candidates). With the default 3-hour grace and the `jobs`
queue's 900 s visibility timeout, that single-job mode holds the message for hours: it works only
because the worker heartbeats with ChangeMessageVisibility every timeout/3, and it ties up a
worker slot meanwhile. The two-job mode avoids the wait:

1. `scanCollection(provider, { collectionId, knownFaceIds })` returns an `OrphanScan`
   (serializable: collection id, `listedAtMs`, candidate ids). Store it (database or S3, keyed by
   collection).
2. In a later run, call `deleteOrphans(provider, scan, { knownFaceIds, graceMs })`. It refuses to
   run before `listedAtMs + graceMs`, checks every batch against the database again right before
   deleting it, and deletes only candidates that are still unknown.

With a daily schedule, each run can first delete the candidates stored by the previous run (about
a day old, more than the grace unless the grace is close to its 24-hour maximum) and then store a
fresh scan. If `deleteOrphans` refuses because the grace hasn't passed yet, keep the stored scan
for the next run.

### 7. Grace comes from config

Always pass `config.index.orphanGraceMs` (`FACE_ORPHAN_GRACE_MS`) as `graceMs`, to
`recordFacesDeadline` and to reconciliation alike. The two must use the same value: a shorter
reconcile grace than the one the indexing deadline was computed with deletes in-flight faces.
