# ADR 0009: Self-hosted face recognition on the VPS (ONNX models, pgvector)

- Status: Accepted (the owner's decision of 2026-10-28). The production model is still open: it is
  chosen in Phase 0 and recorded as an amendment to this ADR.
- Date: 2026-10-29
- Supersedes: ADR 0008 section 5 (face search with Rekognition image bytes) and the parts of ADR
  0008's title, Context and Consequences that keep Rekognition on AWS
- Amends: ADR 0001 (the `FaceProvider` comment "Production uses Rekognition"), the
  photo-platform skill sections "Tech stack" (Face AI), "Invariants" (no InsightFace models,
  consent before any call to Rekognition), "Face indexing", "Face search" and "Admin dashboard"
  (Rekognition cost)

## Context

The owner dropped Amazon Rekognition because of its price: every indexed photo costs at least
one `IndexFaces` call (more with tiles), every scan one `SearchFacesByImage` per selfie plus the
expansion searches, and every stored face a monthly fee. It also keeps a second cloud provider,
AWS keys on the VPS and a cross-border biometric processor just for faces. Face detection and
recognition move onto the Singapore VPS that already runs everything else (ADR 0008). The
owner's priorities are speed and accurate matching.

The production model is not chosen. Open models differ a lot in accuracy on event photos
(small, blurred and turned faces) and in licence terms, and the platform rule stands that
accuracy is measured on real event photos, never assumed. The code therefore has to make the
model a configuration choice that Phase 0 can compare, not a rewrite.

What already exists and stays:

- `FaceProvider` (packages/face, ADR 0001) is the only way api and worker reach face
  recognition. Everything around it (indexing with tiles and the record-faces deadline, orphan
  reconciliation, expansion search, bucketing, face deletion, expiry, purges) talks to that
  interface, not to Rekognition.
- `tools/face-eval` runs the production indexing and search code against a provider and reports
  precision and recall per threshold and pipeline option.

## Decision

### 1. A self-hosted `FaceProvider`, selected by configuration

- `FACE_PROVIDER` (packages/shared, contracts) picks the backend: `self-hosted` (the default) or
  `rekognition`. The Rekognition provider stays selectable until Phase 0 is done, so a
  comparison against it remains possible; it is removed by a later change once the owner
  confirms, together with the `REKOGNITION_*` settings. With `self-hosted`, no `REKOGNITION_*`
  key is required and no AWS call is made.
- `SelfHostedFaceProvider` (packages/face) implements `FaceProvider` with the same semantics the
  rest of the system relies on:
  - a **collection** is the set of vectors with one `collection_id` (`pg-{photographerId}`, still
    built only by `faceCollectionId`); `createCollection` makes nothing and returns the model id
    as `faceModelVersion`; `deleteCollection` deletes the collection's vectors;
  - `indexFaces` detects, embeds and inserts the faces of one image with fresh UUID face ids and
    `externalImageId = fileId`. It is not idempotent, like IndexFaces: an error while inserting
    is reported as `IndexFacesOutcomeUnknownError`, so the existing orphan rules (packages/face
    README) keep working unchanged; reconciliation lists vectors with `listFaces`;
  - faces smaller than `FACE_MIN_FACE_PX` and faces beyond `maxFaces` come back as unindexed with
    Rekognition's reasons `SMALL_BOUNDING_BOX` and `EXCEEDS_MAX_FACES`, so `signal` tiling works
    as before;
  - `searchFacesByImage` embeds the largest face in the selfie (Rekognition's rule) and throws
    `NoFaceDetectedError` when there is none; `searchFaces` searches with a stored vector and
    leaves that face out; `deleteFaces` ignores ids that are gone.
- `faces.rekognition_face_id` keeps its name (renaming touches every face query for no
  behaviour change); it now holds the provider's face id. The `faces` table stays the record of
  which faces exist; the vectors live beside it (section 4).

### 2. Models: a registry, pinned files, nothing committed

- Detection: **YuNet** (`face_detection_yunet_2023mar.onnx`, OpenCV Zoo, MIT licence). Its ONNX
  graph has a fixed 640 × 640 input, so the provider detects on the image scaled to
  `FACE_DETECTOR_LONG_EDGE` in overlapping 640 px windows plus one pass over the whole image at
  640 px, and merges the results with non-maximum suppression. Detections that touch an inner
  window edge are dropped (the whole-image pass or the neighbouring window holds the face).
- Recognition (placeholder): **SFace** (`face_recognition_sface_2021dec.onnx`, OpenCV Zoo,
  Apache-2.0), 128-dimensional embeddings from a 112 × 112 crop aligned on YuNet's five
  landmarks. SFace is used **only for development, demos and as the Phase 0 baseline**. It is
  not approved for production: its weights' licence is Apache-2.0, but it was trained on public
  face datasets whose terms restrict commercial use, which legal/the DPO must review before any
  production use. The same review covers YuNet's training data (WIDER FACE).
- The registry (`FACE_MODELS` in packages/shared, contracts) lists every model id with its file
  name, download URL, SHA-256, licence, input size, embedding dimension and starting thresholds.
  `FACE_DETECTOR_MODEL` and `FACE_MODEL` pick entries by id; `FACE_MODEL_DIR` is the directory
  that holds the files. Model files are never committed: `pnpm --filter @shotx/face
models:download` fetches the configured files and refuses any whose SHA-256 differs from the
  registry. The api and worker images run the same script at build time, and the provider
  verifies the hash again when it loads a file.
- Inference runs in-process with **ONNX Runtime** (`onnxruntime-node`, CPU execution provider).
  `FACE_ONNX_THREADS` sets the intra-op threads per session. ONNX Runtime 1.30+ uploads usage
  telemetry over HTTPS by default; `ORT_DISABLE_TELEMETRY=1` is set before the library loads (in
  code and in the images), so nothing about inference leaves the VPS.
- **InsightFace pretrained weights stay forbidden** (buffalo_l, antelopev2, …: non-commercial
  research licence). A production candidate must be an ArcFace-class model with a commercial
  licence (for example InsightFace's commercial licence, or a vendor model) and is added as a
  registry entry plus a migration for its vector index (section 4).

### 3. Similarity scale

The provider reports similarity as `100 × cosine` of the L2-normalised embeddings, clamped to
0–100, so `FACE_STRONG`, `FACE_MAYBE`, `FACE_DELETION_THRESHOLD`, bucketing and expansion keep
their 0–100 meaning. Scores are **not comparable across models**: each registry entry carries
starting thresholds, and when `FACE_STRONG` or `FACE_MAYBE` is unset the default comes from the
selected model (Rekognition keeps 95 / 85); `FACE_DELETION_THRESHOLD` defaults to the resulting
`FACE_STRONG`. SFace starts at strong 50, maybe 36 (OpenCV's published 0.363 cosine operating
point). These are starting values only; Phase 0 sets the real ones per model.

`FACE_SEARCH_QUALITY_FILTER` and `FACE_INDEX_QUALITY_FILTER` are Rekognition settings and are
ignored by the self-hosted provider. Its quality gates are `FACE_DETECTOR_MIN_SCORE` and
`FACE_MIN_FACE_PX`.

### 4. Vectors in PostgreSQL with pgvector and HNSW

- The `vector` extension (pgvector 0.8 or newer, for iterative index scans) and one table
  (packages/db, contracts):

  ```
  face_vectors  face_id uuid PK, collection_id text, external_image_id text, model text,
                embedding vector (no fixed dimension), created_at
                index (collection_id, face_id)
                HNSW index per model: ((embedding::vector(N)) vector_cosine_ops) WHERE model = '<id>'
  ```

  Without a fixed dimension one table holds every model; each model gets a partial HNSW index on
  its cast, created by the migration that adds the model. Search filters on `collection_id` and
  `model`, so vectors of a model that is no longer selected are never compared with new ones.

- A search runs in one transaction with `hnsw.ef_search = FACE_HNSW_EF_SEARCH`,
  `hnsw.iterative_scan = relaxed_order` and `hnsw.max_scan_tuples = FACE_HNSW_MAX_SCAN_TUPLES`:
  the index is global and the collection filter is applied while scanning. The nearest
  `maxFaces` are taken in a materialised CTE and filtered by the threshold afterwards (pgvector's
  documented pattern). The planner may also choose the `(collection_id, face_id)` index and an
  exact scan. **Known gap (before launch):** when one collection is a small share of a large
  table and the planner picks HNSW, the scan stops at `max_scan_tuples` and can miss that
  collection's matches, which lowers recall for search and for face deletion (a PDPA path). The
  fix is decided with real data volumes: an exact scan below a per-collection size, list
  partitions by `collection_id`, or a scan budget sized from the collection's share, with a
  selective-filter recall test.
- No separate vector database. One Postgres keeps one backup, one deletion path and transactional
  `DELETE`s, and pgvector at the expected scale (millions of faces) fits the VPS.
- The Postgres image becomes `postgres:18-alpine` plus pgvector built from a pinned release
  (`deploy/postgres-image/Dockerfile`), for the dev compose and production alike. Staying on the
  same base keeps the existing dev volume (its collation is musl's) valid. CI uses the same
  build.
- **Changing the model** means: a registry entry and a migration for its HNSW index, re-indexing
  every covered file with the new model, then switching `FACE_MODEL`. A re-index job (clear the
  file's faces and `face_count`, let the faces sweep index it again) is a follow-up; until then a
  model switch is only done on empty or test data.

### 5. Where inference runs

- **Worker**: indexing (`index.file`), detection and embedding of every photo and tile. This is
  the heavy part and it stays asynchronous on the `faces` queue.
- **API**: the selfie only (at most `FACE_MAX_SELFIES` per request, already rate-limited), in
  process, with the same model files. Concurrency is bounded per process by
  `FACE_INFERENCE_CONCURRENCY`; a request that would wait longer than
  `FACE_INFERENCE_MAX_WAIT_MS` fails with `RateLimitedError`, which the API returns as
  `RATE_LIMITED` with `Retry-After`. Selfies are decoded at most `FACE_SELFIE_LONG_EDGE` and
  refused above `FACE_DECODE_MAX_PIXELS` (from the header, before decoding), so an anonymous
  selfie can't exhaust the api's memory. Sending the selfie to the worker over the queue was rejected: it adds a round
  trip to the only synchronous call and makes the worker's backlog decide scan latency.
- If API and worker inference compete for the VPS CPU in the post-race spike, the next step is a
  separate inference container (same provider code behind a small internal HTTP service), sized
  from the load test. Whether the VPS needs a GPU is decided from measured speed, not assumed.

### 6. PDPA

- Biometric templates (embeddings) are now stored by us, in Postgres on the VPS, instead of in
  Rekognition. Selfies are still never persisted: their embeddings exist only in memory for the
  request.
- Faces are deleted with their vectors in the same paths as before (purge, expiry, "ขอลบใบหน้า
  ของฉัน", folder unindexing): `deleteFaces` deletes the rows, so deletion is immediate.
- **Backups exclude `face_vectors` data** (`pg_dump --exclude-table-data=face_vectors`), so
  biometric templates never leave the VPS in a dump and a deleted face does not survive in old
  backups. After a restore the `faces` rows have no vectors; RESTORE.md gains the step to clear
  them and let the faces sweep re-index covered files (the re-index tool is the same follow-up as
  in section 4).
- Rekognition (AWS) is no longer a processor of face data once `FACE_PROVIDER=self-hosted`. The
  consent texts change accordingly (a new `CONSENT_POLICY_VERSION`): face comparison runs on our
  own servers in Singapore, operated by our VPS provider. The DPO reviews the new text, the
  model and training-data licences, and the retention of `face_vectors`.

### 7. Phase 0 compares models

`tools/face-eval` gains `--provider self-hosted --models <id,…>`: the same dataset is indexed and
searched once per model (and per pipeline option), and the report shows the numbers per model.
Vectors stay in memory with exact cosine search, so the comparison measures the models, not the
ANN index. Nothing leaves the machine, so no AWS acknowledgement is needed, but the dataset
rules (consent, git-ignored folders, aggregate reports only) are unchanged. The consent text for
Phase 0 volunteers changes from "processed by Amazon Rekognition" to "processed on our own
machines".

### 8. Local development and demos

With the models downloaded and the pgvector image, face scan works on a Mac and in the
`.demo/` tunnel setup: `FACE_SEARCH_ENABLED=true` and `FACE_PROVIDER=self-hosted` in `.env`.
LocalStack is no longer involved in face search.

## Consequences

- **Cost:** no per-call or per-face fees. Indexing and scans cost VPS CPU instead; the admin cost
  constants `REKOGNITION_CALL` and `REKOGNITION_FACE_MONTH` go away with the Rekognition provider,
  and the system panel reports inference latency and queue depth instead of Rekognition calls.
- **Accuracy is ours to own.** Rekognition's accuracy came with the service; now it depends on
  the model, the detector and the thresholds. SFace is known to be weaker than ArcFace-class
  models on hard faces: Phase 0 must compare it against at least one commercially licensable
  ArcFace-class candidate on the real event before launch.
- **Capacity:** the post-race scan spike runs on the VPS CPU. The k6 load test (deploy/LOADTEST.md)
  must include selfie inference, and `FACE_INFERENCE_CONCURRENCY` and the face-search rate limits
  are sized from it.
- **Images:** the api and worker images grow by the ONNX Runtime binaries (about 40 MB) and the
  model files (SFace about 37 MB, YuNet 0.2 MB). Both images are Debian (glibc) based, which ONNX
  Runtime's prebuilt Node binaries need.
- **Database:** `face_vectors` adds about 0.6 KB per face for SFace (128 float4 plus the HNSW
  graph), about 2.5 KB for a 512-dimensional model. A photographer with 100,000 indexed faces
  adds roughly 60–250 MB.
- **Image byte limit:** `FACE_INDEX_MAX_BYTES` and the 5 MiB encode loop stay (they bound memory
  and keep the code shared with the Rekognition path); the self-hosted provider accepts the same
  limit.

## Alternatives considered

- **Keep Rekognition.** Rejected by the owner: cost.
- **A dedicated vector database (Qdrant, Milvus).** Better filtered-ANN performance at very large
  scale, but another service to run, back up and delete from on one VPS. pgvector is enough at the
  expected scale; revisit if a collection grows past what HNSW plus iterative scan serves within
  the latency budget.
- **Python inference service (InsightFace, OpenCV).** The Python InsightFace stack comes with the
  forbidden pretrained weights and a second runtime. ONNX Runtime runs the same ONNX files from
  Node, in the processes that already exist.
- **OpenCV's DNN module through `opencv4nodejs`.** Unmaintained native bindings; ONNX Runtime is
  maintained and has prebuilt binaries for macOS and Linux.
- **Store embeddings in the `faces` table.** Fewer tables, but the provider would no longer own its
  storage and every orphan rule (indexed but not yet recorded) would need rewriting.

## Follow-ups before launch (from the review of the first implementation)

1. HNSW recall for small collections in a large table (section 4, known gap).
2. Refuse registry models with `production: false` outside local/dev stages (a stage gate, like
   the fake adapters), with an explicit, logged override for Phase 0 rehearsals.
3. Separate inference wait limits for the api and the worker (the worker should queue, not fail
   after `FACE_INFERENCE_MAX_WAIT_MS`), a check that `WORKER_FACES_CONCURRENCY` and
   `FACE_INFERENCE_CONCURRENCY` agree, and a measured self-hosted time budget instead of the
   Rekognition worst-case maths in the worker's start-up check.
4. Switching an existing database from `rekognition` to `self-hosted`: delete the Rekognition
   collections first (the self-hosted provider can't reach them), then forget the `faces` rows
   and re-index, as in deploy/RESTORE.md. Until then, switch only on empty or test data.
5. The re-index tool (sections 4 and 6), replacing the manual SQL in RESTORE.md.
6. Tests still to add: api face search and face deletion through `SelfHostedFaceProvider` (a
   fake engine; consent before the engine, the deletion threshold on the 100 × cosine scale), and
   the worker's `delete.faces`, purge `deleteCollection` and expiry against `face_vectors`.

## Open questions for the owner

1. Which production model candidates to evaluate in Phase 0, and their licence cost (for example
   InsightFace's commercial licence for an ArcFace-class model)?
2. VPS size: CPU only, or a GPU instance if Phase 0 and the load test show the CPU is too slow?
3. When may the Rekognition provider and the `REKOGNITION_*` settings be removed?

## Order of work

1. This ADR.
2. Contracts: `FACE_PROVIDER`, the model registry and the self-hosted settings in packages/shared;
   the pgvector migration and `face_vectors` in packages/db; the Postgres image; the new consent
   policy version.
3. packages/face: YuNet detection, alignment, SFace embedding, the pgvector store and
   `SelfHostedFaceProvider`; the model download script.
4. api and worker wiring, Dockerfiles, backups excluding `face_vectors`; web consent text.
5. face-eval `--provider self-hosted --models`.
6. Local `.env` and the demo.

Each step is reviewed before it is committed. Nothing is pushed or deployed.
