# face-eval

Measures face search accuracy before anyone builds UI on it (build order phase 0). It indexes an
event's photos, scans every volunteer with their selfies the way the share page does, and reports
precision and recall for every FACE_STRONG / FACE_MAYBE pair and pipeline option, per face model
(ADR 0009: the self-hosted provider; Amazon Rekognition stays available for comparison).

It runs the production code from `@shotx/face` (`indexPhoto`, `selectSeeds`, `combineMatches`,
`bucketByFile`). A test checks that its offline threshold sweep returns exactly what
`searchBySelfies` returns at each threshold pair.

## Rules

- **Faces are sensitive personal data (PDPA section 26).** Datasets and raw run output never go into
  git, chat, shared drives, tickets or AI tools. The CLI refuses to read a dataset or write output
  inside the repository unless git ignores the folder (`data/` and `runs/` are ignored).
- Selfies and photos are read only from the dataset folder, kept in memory, and never copied,
  written to storage or logged. Rekognition gets them as bytes (ADR 0008 section 5). Logs and reports contain counts, never image data, names or file contents.
- Committed reports (`reports/`) hold aggregate numbers only.
- Never use InsightFace pretrained models. Recognition goes through `FaceProvider`; a model is
  evaluated only once it is in the registry (`packages/shared/src/config/face-models.ts`).
- `--provider self-hosted` runs our ONNX models on this machine: nothing is sent anywhere.
- Rekognition runs only with `--provider rekognition --i-understand-this-calls-aws`, on an approved
  AWS account.

## Run the synthetic evaluation now

The synthetic dataset uses coloured squares as faces and a deterministic similarity model
(`FakeFaceProvider`). It exercises the whole pipeline without AWS, but **its numbers say nothing
about Rekognition**. Every synthetic report starts with that warning.

```sh
pnpm install
pnpm face-eval synth          # 120 photos, 24 volunteers → tools/face-eval/data/synthetic (~15 s)
pnpm face-eval run            # 144 option combinations → tools/face-eval/runs/<timestamp>-synthetic (~6 min)
pnpm face-eval run --report tools/face-eval/reports/synthetic-sample.md   # also refresh the sample report
pnpm face-eval help           # every option
```

`synth` options: `--photos`, `--volunteers`, `--absent` (volunteers in no photo), `--bystanders`,
`--seed`, `--width`, `--height`, `--out`, `--force`.

With the fake provider the grid also replays the old 15 MiB S3 limit next to `FACE_INDEX_MAX_BYTES`
(5 MiB), as a reference that is never recommended. Synthetic photos are far below 5 MiB (about
370 KB at 3,500 px), so both limits send byte-identical images and give identical numbers: the
synthetic data says nothing about what 5 MiB does to real photos.

## Prepare the real dataset

### What to collect

- **One real event**: the photographer's delivered photos at full resolution (JPEG, PNG or WebP;
  convert HEIC first), ideally 1,000–3,000 photos with the usual mix of portraits, groups, crowds
  and finish-line shots.
- **20–30 volunteers who attended**, as varied as the audience: age, gender, skin tone, glasses,
  hats, helmets. Add 2–3 volunteers who were **not** at the event: they measure false matches for
  people who should get nothing back.
- **Selfies**: up to 3 per volunteer, taken like on the share page: phone front camera, face
  straight, then slightly left, then slightly right, normal light, no sunglasses or mask.

### Consent (PDPA)

Before collecting anything, get explicit written consent from every volunteer. The DPO or legal
team approves the text. It must cover:

- the purpose (testing face search accuracy, including comparing face models) and that face data
  is biometric, sensitive data;
- where it is processed: on the company's own machines with `--provider self-hosted` (ADR 0009);
  if Rekognition is also compared, by Amazon Rekognition in AWS `ap-southeast-1` (Singapore),
  which is a transfer outside Thailand;
- the retention period, and deletion of the dataset, run output and any Rekognition collections
  afterwards;
- withdrawal: a volunteer who withdraws is removed from `labels.json` and `selfies/`, and any run
  that used their data is deleted.

The event's organiser notice must also allow using the photos for this test, because bystanders
appear in them. Only volunteers are ever searched.

### Folder layout

```
<dataset>/
  labels.json                 ground truth (below)
  photos/                     event photos; subfolders allowed; hidden files ignored
    start/IMG_0001.jpg
    finish/IMG_0450.jpg
  selfies/
    v01/1-front.jpg           used in file-name order: the first selfie is the "1 selfie" case
    v01/2-left.jpg
    v01/3-right.jpg
    v02/1-front.jpg
```

### `labels.json`

```json
{
  "version": 1,
  "event": "Sample Run 2026, consent batch A",
  "persons": {
    "v01": ["start/IMG_0001.jpg", "finish/IMG_0450.jpg"],
    "v02": [],
    "v03": ["start/IMG_0001.jpg"]
  }
}
```

- Keys are pseudonyms (`[A-Za-z0-9_-]`, at most 32 characters), such as `v01`. Never use names, bib
  numbers or emails. Keep the pseudonym ↔ person mapping on paper or in the consent records, not in
  the dataset.
- Each list holds **every** photo in which someone who knows the volunteer can recognise their face,
  including small, blurred or turned faces. Leave out photos where only the back of the head shows.
  An empty list means the volunteer is in no photo.
- Label by looking at every photo, not by running a search: labels built from search results hide
  the misses. Have a second person check each volunteer's list.
- Every volunteer needs a `selfies/<id>/` folder with 1–5 selfies, and every selfie folder needs an
  entry in `labels.json`.

Check the dataset. The output is counts only:

```sh
pnpm face-eval validate --dataset tools/face-eval/data/<event>
```

### Where to keep it

Keep it in `tools/face-eval/data/<event>/` (git-ignored) or outside the repository on an encrypted
disk. Don't copy it anywhere else, and delete the dataset, `runs/` output and any kept collections
when the retention period ends.

## Measure the 5 MiB limit on the real dataset (no AWS)

Since ADR 0008 section 5 every image goes to Rekognition as bytes, at most 5 MiB
(`FACE_INDEX_MAX_BYTES`); before, index images went through S3 with a 15 MiB limit. The S3 path is
gone, so Rekognition can no longer compare the two directly. It doesn't need to: an image that fits
5 MiB at `FACE_INDEX_JPEG_QUALITY` and `FACE_INDEX_LONG_EDGE` is byte-identical under 15 MiB, so
accuracy can only differ on the images the encoder had to **degrade** (lower quality, then a
smaller size). Count them locally first:

```sh
pnpm face-eval encode --dataset tools/face-eval/data/<event> > tools/face-eval/runs/<event>-encode.json
```

It encodes every photo (full image and all 2×2 tiles) under 15 MiB and 5 MiB (`--index-max-bytes`,
`--long-edges` to change them) without calling any provider and prints counts only: the share of
photos whose full image is degraded, the lowest quality used, how many tiles are degraded, and the
full-image size distribution without a limit. Keep the JSON under `runs/` (git-ignored).

- If almost nothing is degraded, the 5 MiB results stand for the old path as well.
- If many photos are degraded, run the evaluation below with `--index-max-bytes 2.5MiB,5MiB`: if
  recall barely moves between 2.5 and 5 MiB, the step from 5 to 15 MiB would not have mattered
  either. If it drops, tiling (`FACE_INDEX_TILING=always`) is the first lever (ADR 0008).

## Compare self-hosted models (no network)

The Phase 0 decision for ADR 0009: run every candidate model on the same real dataset with the
production pipeline (YuNet detection, alignment, embedding, expansion, bucketing). Vectors stay in
memory with exact cosine search, so the numbers are the model's, not the HNSW index's.

```sh
pnpm face-models --all          # every registry model into .models/face, checked by SHA-256
pnpm face-eval run \
  --dataset tools/face-eval/data/<event> \
  --provider self-hosted --models sface-2021dec[,<candidate>] \
  --report tools/face-eval/reports/<event>.md
```

- Each model gets its own run folder and report (`<event>-<model>.md`), plus
  `runs/<timestamp>-compare.md` with every model at its own recommended operating point.
  Similarity is 100 × cosine and **not comparable across models**: compare precision, recall and
  go/no-go, and adopt the winning model's `FACE_STRONG` / `FACE_MAYBE`.
- The threshold sweeps default to 20–80 (strong) and 15–70 (maybe), the cosine range that matters;
  `--quality-filters` is a Rekognition setting and is ignored (the self-hosted gates are
  `FACE_DETECTOR_MIN_SCORE` and `FACE_MIN_FACE_PX`, set them in the environment to compare).
- SFace is the development placeholder and is not approved for production (training-data terms);
  a candidate must have a commercial licence before it goes into the registry.
- Costs in the report count no per-call fees; the real cost is VPS CPU time, measured with the
  load test (deploy/LOADTEST.md).

## Run the real evaluation with Rekognition (later, with approval)

This calls Amazon Rekognition: it is billed and sends the photos and selfies to AWS
`ap-southeast-1`. Photos (full image and tiles) and selfies are sent as bytes of at most 5 MiB and
never stored. The Rekognition client is built from `loadRekognitionClientConfig` (ADR 0008
section 1), with stricter rules for the evaluation: it needs the evaluation account's own keys
(never the default credential chain), refuses a `REKOGNITION_ENDPOINT_URL` that isn't AWS, and
always gives the client an explicit endpoint: that AWS URL, or else
`https://rekognition.<REKOGNITION_REGION>.amazonaws.com`. AWS SDK v3 applies `AWS_ENDPOINT_URL`,
`AWS_ENDPOINT_URL_REKOGNITION` and `endpoint_url` from `~/.aws/config` only to clients without an
explicit endpoint, so none of them can send an evaluation elsewhere, on any `APP_STAGE`. The local
`.env` points `REKOGNITION_ENDPOINT_URL` at LocalStack, so unset it:

```sh
set -a; source .env; set +a
unset REKOGNITION_ENDPOINT_URL
export REKOGNITION_REGION=ap-southeast-1
export REKOGNITION_ACCESS_KEY_ID=<evaluation IAM user>      # Rekognition on collection/pg-eval-* only
export REKOGNITION_SECRET_ACCESS_KEY=<its secret>
pnpm face-eval run \
  --dataset tools/face-eval/data/<event> \
  --provider rekognition --i-understand-this-calls-aws \
  --report tools/face-eval/reports/<event>.md
```

- **Byte limits:** `--index-max-bytes` defaults to `FACE_INDEX_MAX_BYTES` (5 MiB) for Rekognition.
  Limits above 5 MiB are refused (use `face-eval encode` for the 15 MiB comparison).
- **Cost:** the full grid indexes the event 18 times. Before any call, the CLI prints an upper bound
  on provider calls. On the synthetic data the full grid made about 51 IndexFaces calls per photo,
  so budget about 50,000 calls (about $50) per 1,000 photos. Narrow the grid to spend less, for
  example
  `--long-edges 2400,3500 --quality-filters LOW,MEDIUM --tiling never,signal`.
- **Rate:** calls go through in-process rate limiters at `FACE_REKOGNITION_TPS_*` (never more than
  that many calls of one operation in any second), with `FACE_REKOGNITION_*` retries (worker
  profile). IndexFaces is retried only when throttled. Set the rates at or below the account's
  quotas.
- **Cleanup:** every evaluation collection (`pg-eval-<timestamp>-<option>`) is deleted at the end;
  `--keep-collections` keeps them.
- **Gap:** no YuNet detector is wired in yet, so on real photos `signal` tiling relies only on
  Rekognition's `SMALL_BOUNDING_BOX` / `EXCEEDS_MAX_FACES` reasons. The synthetic run models a local
  detector.

## Read the report

- **Recommendation**: the value for `FACE_STRONG`, `FACE_MAYBE` and every pipeline option, next to
  the value in the config the run used (tiling is `FACE_INDEX_TILING`). To adopt the values,
  change the `FACE_*` defaults or the environment; the defaults live in `packages/shared`.
- **Strong** counts only the "ใช่คุณ" group (≥ FACE_STRONG). **Strong+maybe** counts both groups
  (≥ FACE_MAYBE).
- **Micro** sums true positives, false positives and false negatives over all volunteers before
  computing precision, recall and F1, so volunteers in many photos weigh more. **Macro** computes the
  rates per volunteer and averages them, so every volunteer weighs the same. Macro precision
  averages volunteers who got at least one photo back; macro recall and F1 average volunteers who are
  in at least one photo.
- **Zero-result rate**: the share of volunteers in the event who got nothing back. Production tracks
  the same number per scan, together with the "ไม่ใช่ฉัน" rate.
- **Operating point**: the lowest FACE_STRONG whose strong precision meets `--strong-precision`
  (default 98%) at that value and every value above it, then the lowest FACE_MAYBE whose
  strong+maybe precision meets `--overall-precision` (default 90%). Among the options that meet both
  targets, the cheapest one within `--recall-tolerance` (1%) of the best strong+maybe recall is
  recommended.
- **Go / no-go**: both precision targets, strong+maybe recall ≥ `--min-recall` (80%), and a
  zero-result rate ≤ `--max-zero-result` (10%). With 20–30 volunteers, read the 95% intervals:
  they assume independent (volunteer, photo) pairs, so the real uncertainty is wider.
- **Index image byte limit** and **Index image encoding**: per option, how many photos had their full
  image or any tile degraded to fit the limit, the lowest JPEG quality used, and the bytes sent.
  "Upload per 1,000 photos" is the VPS bandwidth that indexing sends to Rekognition.
- **Calls per 1,000 photos**: indexing calls measured on the dataset, scaled to 1,000 photos, plus
  `--scans-per-1000-photos` (default 100, an assumption) × search calls per scan. USD and THB come
  from `REKOGNITION_CALL`, `REKOGNITION_FACE_MONTH` and `USD_THB` in `packages/shared`.
- **Failure analysis**: misses that a lower threshold would find versus photos never returned, false
  matches by group, and zero-result volunteers. Synthetic runs also break recall down by face size
  and pose.

## Outputs

| Path                                 | Contents                                                                       | Commit?   |
| ------------------------------------ | ------------------------------------------------------------------------------ | --------- |
| `data/<dataset>/`                    | photos, selfies, labels                                                        | **never** |
| `runs/<timestamp>-<kind>/run.json`   | config, grids, per-option metrics, per-volunteer counts (pseudonyms), failures | **never** |
| `runs/<timestamp>-<kind>/scans.json` | raw similarities per volunteer, photo id and option, for re-analysis           | **never** |
| `runs/<timestamp>-<kind>/report.md`  | the report                                                                     | no        |
| `reports/<name>.md`                  | the report (aggregate numbers only)                                            | yes       |

Re-run the evaluation whenever face-pipeline code in `packages/face` changes.

## Development

```sh
pnpm --filter @shotx/face-eval test        # loader, metrics, analysis, report, CLI guard, harness vs production search
pnpm --filter @shotx/face-eval typecheck
pnpm --filter @shotx/face-eval lint
```
