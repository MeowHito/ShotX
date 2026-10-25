# face-eval

Measures face search accuracy before anyone builds UI on it (build order phase 0). It indexes an
event's photos, scans every volunteer with their selfies the way the share page does, and reports
precision and recall for every FACE_STRONG / FACE_MAYBE pair and pipeline option, plus the Amazon
Rekognition calls and cost per 1,000 photos.

It runs the production code from `@shotx/face` (`indexPhoto`, `selectSeeds`, `combineMatches`,
`bucketByFile`). A test checks that its offline threshold sweep returns exactly what
`searchBySelfies` returns at each threshold pair.

## Rules

- **Faces are sensitive personal data (PDPA section 26).** Datasets and raw run output never go into
  git, chat, shared drives, tickets or AI tools. The CLI refuses to read a dataset or write output
  inside the repository unless git ignores the folder (`data/` and `runs/` are ignored).
- Selfies are read only from the dataset folder, kept in memory, and never copied, uploaded to S3 or
  logged. Logs and reports contain counts, never image data, names or file contents.
- Committed reports (`reports/`) hold aggregate numbers only.
- Never use InsightFace pretrained models. Recognition goes through `FaceProvider`.
- Rekognition runs only with `--provider rekognition --i-understand-this-calls-aws`, on an approved
  AWS account.

## Run the synthetic evaluation now

The synthetic dataset uses coloured squares as faces and a deterministic similarity model
(`FakeFaceProvider`). It exercises the whole pipeline without AWS, but **its numbers say nothing
about Rekognition**. Every synthetic report starts with that warning.

```sh
pnpm install
pnpm face-eval synth          # 120 photos, 24 volunteers → tools/face-eval/data/synthetic (~15 s)
pnpm face-eval run            # 72 option combinations → tools/face-eval/runs/<timestamp>-synthetic (~3 min)
pnpm face-eval run --report tools/face-eval/reports/synthetic-sample.md   # also refresh the sample report
pnpm face-eval help           # every option
```

`synth` options: `--photos`, `--volunteers`, `--absent` (volunteers in no photo), `--bystanders`,
`--seed`, `--width`, `--height`, `--out`, `--force`.

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

- the purpose (testing face search accuracy) and that face data is biometric, sensitive data;
- processing by Amazon Rekognition in AWS `ap-southeast-1` (Singapore), which is a transfer
  outside Thailand;
- the retention period, and deletion of the dataset, run output and Rekognition collections
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

## Run the real evaluation (later, with approval)

This calls Amazon Rekognition: it is billed and sends the photos and selfies to AWS. Selfies are sent
inline and never stored. Photos are sent inline (up to 5 MB) or, with `--temp-bucket`, through
`s3://<bucket>/tmp/index/`, which the bucket's `tmp/` lifecycle rule expires. Each object is deleted
right after IndexFaces.

```sh
export AWS_REGION=ap-southeast-1          # plus credentials for the approved evaluation account
pnpm face-eval run \
  --dataset tools/face-eval/data/<event> \
  --provider rekognition --i-understand-this-calls-aws \
  --temp-bucket <bucket> \
  --report tools/face-eval/reports/<event>.md
```

- **Cost:** the full grid indexes the event 18 times. Before any call, the CLI prints an upper bound
  on provider calls. On the synthetic data the full grid made about 51 IndexFaces calls per photo,
  so budget about 50,000 calls (about $50) per 1,000 photos. Narrow the grid to spend less, for
  example
  `--long-edges 2400,3500 --quality-filters LOW,MEDIUM --tiling never,signal`.
- **Rate:** calls go through in-process token buckets at `FACE_REKOGNITION_TPS_*`, with
  `FACE_REKOGNITION_*` retries (worker profile). Set the rates below the account's quotas.
- **Cleanup:** every evaluation collection (`pg-eval-<timestamp>-<option>`) is deleted at the end;
  `--keep-collections` keeps them.
- **Gap:** no YuNet detector is wired in yet, so on real photos `signal` tiling relies only on
  Rekognition's `SMALL_BOUNDING_BOX` / `EXCEEDS_MAX_FACES` reasons. The synthetic run models a local
  detector.

## Read the report

- **Recommendation**: the value for `FACE_STRONG`, `FACE_MAYBE` and every pipeline option, next to
  the value in the config the run used. Tiling has no config key yet (`FACE_INDEX_TILING` was
  requested from contracts). To adopt the values, change the `FACE_*` defaults or the environment;
  the defaults live in `packages/shared`.
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
