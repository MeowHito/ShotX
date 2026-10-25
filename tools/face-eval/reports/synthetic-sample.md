> **SYNTHETIC DATA: NOT A BASIS FOR PRODUCTION THRESHOLDS.**
> Every number below comes from a synthetic dataset (`face-eval synth`) scored by the
> deterministic FakeFaceProvider, not by Amazon Rekognition. It shows that the harness works and
> how to read the report. Choose FACE_STRONG, FACE_MAYBE and the pipeline options only from a
> run on the real event dataset (see tools/face-eval/README.md).

# Face search evaluation: Synthetic event (seed 1)

- Generated 2026-10-25T07:16:52.558Z from commit `22bd815`.
- Provider: FakeFaceProvider (deterministic synthetic similarity model, no AWS calls), face model fake.
- Dataset: 120 photos (13 without any volunteer), 24 volunteers (2 in no photo), 334 labelled appearances, 72 selfies.
- Grid: index long edge 1600, 2400, 3500 px; QualityFilter LOW, MEDIUM; tiling never, signal, always; expansion seeds 0, 2; selfies 1, 3; FACE_STRONG 80–99; FACE_MAYBE 70–95.
- Targets: "ใช่คุณ" precision ≥ 98%, strong+maybe precision ≥ 90%; options within 1% recall of the best count as equal and the cheapest wins.

## Recommendation

Recommended pipeline: Index long edge 2400 px, IndexFaces QualityFilter MEDIUM, Tiling always, Expansion on (2 seeds), Selfies per scan 1.

| Setting                   | Config key                                | Recommended | Value in this run’s config |
| ------------------------- | ----------------------------------------- | ----------- | -------------------------- |
| "ใช่คุณ" threshold        | `FACE_STRONG`                             | 91          | 95                         |
| "อาจจะเป็นคุณ" threshold  | `FACE_MAYBE`                              | 87          | 85                         |
| Index long edge           | `FACE_INDEX_LONG_EDGE`                    | 2400 px     | 3500 px                    |
| IndexFaces QualityFilter  | `FACE_INDEX_QUALITY_FILTER`               | MEDIUM      | LOW                        |
| Tiling                    | none yet (requested: `FACE_INDEX_TILING`) | always      | –                          |
| Expansion seeds (0 = off) | `FACE_EXPANSION_SEEDS`                    | 2           | 2                          |
| Selfies per scan          | `FACE_MAX_SELFIES`                        | 1           | 3                          |

- **"ใช่คุณ" (strong):** micro precision 98.8% (95% CI 95.9–99.7%), micro recall 50.9% (95% CI 45.6–56.2%), micro F1 67.2%; macro precision 99.1%, macro recall 50.8%, macro F1 65.7%; zero-result rate 4.5% (1 of 22 persons).
- **"ใช่คุณ" + "อาจจะเป็นคุณ" (strong+maybe):** micro precision 90.2% (95% CI 86.0–93.2%), micro recall 71.3% (95% CI 66.2–75.8%), micro F1 79.6%; macro precision 94.2%, macro recall 71.1%, macro F1 80.0%; zero-result rate 0.0% (0 of 22 persons).
- **Expansion:** 72 correct photos were found only through expansion.
- **Rekognition calls per 1,000 photos:** 5,938 = 5,675 for indexing (5.00 IndexFaces + 0.68 DeleteFaces per photo) + 263 for 100 scans (2.63 calls per scan). About $5.94 (฿196), plus $0.10 per month to keep 9,883 faces indexed (฿9.78 over 3 months).

## Go / no-go

| Criterion                          | Target | Actual | Result |
| ---------------------------------- | ------ | ------ | ------ |
| "ใช่คุณ" micro precision           | ≥ 98%  | 98.8%  | PASS   |
| strong+maybe micro precision       | ≥ 90%  | 90.2%  | PASS   |
| strong+maybe micro recall          | ≥ 80%  | 71.3%  | FAIL   |
| zero-result rate (present persons) | ≤ 10%  | 0.0%   | PASS   |

Verdict on this synthetic data: NO-GO. It says nothing about Rekognition on real photos.

## How to read this report

- A **scan** is one volunteer searching with their selfies, exactly as on the share page. For each scan the harness compares the photos returned with the photos the volunteer is labelled in.
- **Strong** counts only the "ใช่คุณ" group (similarity ≥ FACE_STRONG). **Strong+maybe** counts both groups (≥ FACE_MAYBE).
- **Micro** sums true positives, false positives and false negatives over all volunteers, then computes precision = TP / (TP + FP), recall = TP / (TP + FN) and F1. Volunteers in many photos weigh more.
- **Macro** computes the rates per volunteer, then averages them, so every volunteer weighs the same. Macro precision averages volunteers who got at least one photo back; macro recall and F1 average volunteers who are in at least one photo (F1 is 0 when none of their photos came back).
- **Zero-result rate** is the share of volunteers who appear in the event but got nothing back. Production tracks the same number per scan.
- **95% CI** is a Wilson interval on the micro rate. It treats every (volunteer, photo) pair as independent, so the real uncertainty is larger, especially with few volunteers.
- Each option has its **own operating point**: the lowest FACE_STRONG whose strong precision meets the target at that value and every value above it, then the lowest FACE_MAYBE that does the same for strong+maybe precision.
- **Calls per 1,000 photos** = indexing calls measured on this dataset, scaled to 1,000 photos, + 100 scans × search calls per scan (an assumption: replace it with production scan counts). USD uses REKOGNITION_CALL = $0.001 and REKOGNITION_FACE_MONTH = $0.00001; THB uses USD_THB = 33.

## Threshold sweep (recommended pipeline)

### "ใช่คุณ" by FACE_STRONG

| FACE_STRONG | Precision (micro) | 95% CI      | Recall (micro) | F1 (micro) | Precision (macro) | Recall (macro) | F1 (macro) | Zero-result | Search calls / scan |
| ----------- | ----------------- | ----------- | -------------- | ---------- | ----------------- | -------------- | ---------- | ----------- | ------------------- |
| 80          | 80.2%             | 75.8–84.0%  | 88.6%          | 84.2%      | 87.1%             | 88.7%          | 86.4%      | 0.0%        | 2.83                |
| 81          | 80.4%             | 76.0–84.1%  | 88.3%          | 84.2%      | 87.2%             | 88.4%          | 86.4%      | 0.0%        | 2.83                |
| 82          | 80.6%             | 76.2–84.4%  | 87.1%          | 83.7%      | 87.6%             | 87.4%          | 86.0%      | 0.0%        | 2.83                |
| 83          | 80.6%             | 76.2–84.4%  | 85.9%          | 83.2%      | 87.7%             | 86.3%          | 85.4%      | 0.0%        | 2.83                |
| 84          | 81.2%             | 76.7–85.0%  | 82.6%          | 81.9%      | 88.3%             | 82.9%          | 83.8%      | 0.0%        | 2.83                |
| 85          | 84.1%             | 79.7–87.7%  | 80.8%          | 82.4%      | 89.9%             | 81.2%          | 84.0%      | 0.0%        | 2.83                |
| 86          | 88.5%             | 84.4–91.7%  | 78.4%          | 83.2%      | 92.5%             | 78.6%          | 83.9%      | 0.0%        | 2.83                |
| 87          | 90.0%             | 85.8–93.0%  | 72.8%          | 80.5%      | 93.8%             | 73.0%          | 81.2%      | 0.0%        | 2.83                |
| 88          | 92.7%             | 88.7–95.3%  | 68.3%          | 78.6%      | 96.2%             | 68.7%          | 79.2%      | 0.0%        | 2.83                |
| 89          | 93.2%             | 89.1–95.8%  | 61.4%          | 74.0%      | 96.6%             | 61.9%          | 74.5%      | 0.0%        | 2.79                |
| 90          | 96.1%             | 92.5–98.0%  | 58.7%          | 72.9%      | 97.5%             | 59.6%          | 73.2%      | 0.0%        | 2.75                |
| 91 **←**    | 98.8%             | 95.9–99.7%  | 50.9%          | 67.2%      | 99.1%             | 50.8%          | 65.7%      | 4.5%        | 2.63                |
| 92          | 100.0%            | 97.2–100.0% | 40.4%          | 57.6%      | 100.0%            | 40.1%          | 52.4%      | 22.7%       | 2.38                |
| 93          | 100.0%            | 96.9–100.0% | 36.5%          | 53.5%      | 100.0%            | 36.6%          | 48.3%      | 27.3%       | 2.33                |
| 94          | 100.0%            | 96.4–100.0% | 30.5%          | 46.8%      | 100.0%            | 30.1%          | 41.3%      | 31.8%       | 2.25                |
| 95          | 100.0%            | 95.1–100.0% | 22.5%          | 36.7%      | 100.0%            | 20.9%          | 30.2%      | 40.9%       | 1.96                |
| 96          | 100.0%            | 92.3–100.0% | 13.8%          | 24.2%      | 100.0%            | 13.2%          | 19.9%      | 54.5%       | 1.79                |
| 97          | 100.0%            | 92.3–100.0% | 13.8%          | 24.2%      | 100.0%            | 13.2%          | 19.9%      | 54.5%       | 1.79                |
| 98          | 100.0%            | 90.4–100.0% | 10.8%          | 19.5%      | 100.0%            | 10.5%          | 15.8%      | 63.6%       | 1.63                |
| 99          | 100.0%            | 84.5–100.0% | 6.3%           | 11.8%      | 100.0%            | 6.7%           | 10.4%      | 72.7%       | 1.42                |

### "ใช่คุณ" + "อาจจะเป็นคุณ" by FACE_MAYBE, at FACE_STRONG = 91

| FACE_MAYBE | Precision (micro) | 95% CI     | Recall (micro) | F1 (micro) | Precision (macro) | Recall (macro) | F1 (macro) | Zero-result | Absent persons with results |
| ---------- | ----------------- | ---------- | -------------- | ---------- | ----------------- | -------------- | ---------- | ----------- | --------------------------- |
| 70         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 71         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 72         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 73         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 74         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 75         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 76         | 80.3%             | 76.0–84.0% | 89.2%          | 84.5%      | 87.3%             | 89.2%          | 86.7%      | 0.0%        | 0 of 2                      |
| 77         | 80.3%             | 75.9–84.0% | 88.9%          | 84.4%      | 87.1%             | 88.8%          | 86.5%      | 0.0%        | 0 of 2                      |
| 78         | 80.2%             | 75.8–84.0% | 88.6%          | 84.2%      | 87.0%             | 88.4%          | 86.3%      | 0.0%        | 0 of 2                      |
| 79         | 80.2%             | 75.8–84.0% | 88.6%          | 84.2%      | 87.0%             | 88.4%          | 86.3%      | 0.0%        | 0 of 2                      |
| 80         | 80.1%             | 75.7–83.9% | 88.0%          | 83.9%      | 86.9%             | 87.9%          | 86.0%      | 0.0%        | 0 of 2                      |
| 81         | 80.3%             | 75.9–84.0% | 87.7%          | 83.8%      | 87.0%             | 87.6%          | 86.0%      | 0.0%        | 0 of 2                      |
| 82         | 80.5%             | 76.1–84.3% | 86.5%          | 83.4%      | 87.4%             | 86.6%          | 85.6%      | 0.0%        | 0 of 2                      |
| 83         | 80.5%             | 76.1–84.3% | 85.3%          | 82.8%      | 87.5%             | 85.4%          | 85.0%      | 0.0%        | 0 of 2                      |
| 84         | 81.7%             | 77.2–85.5% | 81.7%          | 81.7%      | 88.4%             | 81.8%          | 83.5%      | 0.0%        | 0 of 2                      |
| 85         | 84.4%             | 80.0–88.0% | 79.3%          | 81.8%      | 89.8%             | 79.3%          | 83.1%      | 0.0%        | 0 of 2                      |
| 86         | 88.6%             | 84.4–91.8% | 76.9%          | 82.4%      | 92.2%             | 76.6%          | 82.8%      | 0.0%        | 0 of 2                      |
| 87 **←**   | 90.2%             | 86.0–93.2% | 71.3%          | 79.6%      | 94.2%             | 71.1%          | 80.0%      | 0.0%        | 0 of 2                      |
| 88         | 92.9%             | 89.0–95.5% | 67.1%          | 77.9%      | 96.3%             | 67.0%          | 78.2%      | 0.0%        | 0 of 2                      |
| 89         | 93.9%             | 89.8–96.4% | 59.9%          | 73.1%      | 96.8%             | 59.8%          | 73.0%      | 0.0%        | 0 of 2                      |
| 90         | 95.9%             | 92.2–97.9% | 56.3%          | 70.9%      | 97.3%             | 56.5%          | 70.7%      | 0.0%        | 0 of 2                      |
| 91         | 98.8%             | 95.9–99.7% | 50.9%          | 67.2%      | 99.1%             | 50.8%          | 65.7%      | 4.5%        | 0 of 2                      |

## Pipeline options

Each table changes one option of the recommended pipeline and scores it at FACE_STRONG = 91 and FACE_MAYBE = 87. The last two columns show the option's own operating point.

### Index long edge

| Value                     | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos | Own FACE_STRONG / FACE_MAYBE | Recall there |
| ------------------------- | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- | ---------------------------- | ------------ |
| 1600 px                   | 97.2%    | 31.1%    | 83.3%          | 47.9%          | 60.8%           | 48.2%   | 0.0%        | 5,908                | 92 / 89                      | 38.3%        |
| 2400 px **(recommended)** | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                | 91 / 87                      | 71.3%        |
| 3500 px                   | 100.0%   | 47.3%    | 90.4%          | 67.4%          | 77.2%           | 66.6%   | 0.0%        | 5,929                | 90 / 87                      | 70.1%        |

### IndexFaces QualityFilter

| Value                    | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos | Own FACE_STRONG / FACE_MAYBE | Recall there |
| ------------------------ | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- | ---------------------------- | ------------ |
| LOW                      | 98.7%    | 45.2%    | 86.7%          | 66.2%          | 75.0%           | 65.3%   | 0.0%        | 5,942                | 91 / 89                      | 56.0%        |
| MEDIUM **(recommended)** | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                | 91 / 87                      | 71.3%        |

### Tiling

| Value                    | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos | Own FACE_STRONG / FACE_MAYBE | Recall there |
| ------------------------ | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- | ---------------------------- | ------------ |
| never                    | 97.4%    | 22.8%    | 89.1%          | 34.4%          | 49.7%           | 34.5%   | 0.0%        | 1,221                | 92 / 88                      | 29.6%        |
| signal                   | 100.0%   | 39.2%    | 88.3%          | 63.5%          | 73.9%           | 62.8%   | 0.0%        | 2,992                | 91 / 88                      | 56.0%        |
| always **(recommended)** | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                | 91 / 87                      | 71.3%        |

### Expansion

| Value                          | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos | Own FACE_STRONG / FACE_MAYBE | Recall there |
| ------------------------------ | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- | ---------------------------- | ------------ |
| off                            | 100.0%   | 32.0%    | 88.8%          | 49.7%          | 63.7%           | 50.2%   | 0.0%        | 5,775                | 90 / 88                      | 45.5%        |
| on (2 seeds) **(recommended)** | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                | 91 / 87                      | 71.3%        |

### Selfies per scan

| Value               | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos | Own FACE_STRONG / FACE_MAYBE | Recall there |
| ------------------- | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- | ---------------------------- | ------------ |
| 1 **(recommended)** | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                | 91 / 87                      | 71.3%        |
| 3                   | 99.4%    | 52.1%    | 87.8%          | 73.1%          | 79.7%           | 73.2%   | 0.0%        | 6,142                | 91 / 88                      | 68.0%        |

## Rekognition calls and cost

| Option (`le<px>-<filter>-<tiling>/s<selfies>-x<seeds>`) | IndexFaces / photo | DeleteFaces / photo | Search calls / scan | Index calls / 1,000 photos | Search calls / 1,000 photos | Total calls / 1,000 photos | USD   | THB  | Faces stored / 1,000 photos | Face storage USD / month |
| ------------------------------------------------------- | ------------------ | ------------------- | ------------------- | -------------------------- | --------------------------- | -------------------------- | ----- | ---- | --------------------------- | ------------------------ |
| `le1600-medium-always/s1-x2`                            | 5.00               | 0.66                | 2.50                | 5,658                      | 250                         | 5,908                      | $5.91 | ฿195 | 8,633                       | $0.09                    |
| `le2400-medium-always/s1-x2` **(recommended)**          | 5.00               | 0.68                | 2.63                | 5,675                      | 263                         | 5,938                      | $5.94 | ฿196 | 9,883                       | $0.10                    |
| `le3500-medium-always/s1-x2`                            | 5.00               | 0.68                | 2.54                | 5,675                      | 254                         | 5,929                      | $5.93 | ฿196 | 9,842                       | $0.10                    |
| `le2400-low-always/s1-x2`                               | 5.00               | 0.69                | 2.50                | 5,692                      | 250                         | 5,942                      | $5.94 | ฿196 | 10,425                      | $0.10                    |
| `le2400-medium-never/s1-x2`                             | 1.00               | 0.00                | 2.21                | 1,000                      | 221                         | 1,221                      | $1.22 | ฿40  | 3,708                       | $0.04                    |
| `le2400-medium-signal/s1-x2`                            | 2.50               | 0.24                | 2.50                | 2,742                      | 250                         | 2,992                      | $2.99 | ฿99  | 7,883                       | $0.08                    |
| `le2400-medium-always/s1-x0`                            | 5.00               | 0.68                | 1.00                | 5,675                      | 100                         | 5,775                      | $5.78 | ฿191 | 9,883                       | $0.10                    |
| `le2400-medium-always/s3-x2`                            | 5.00               | 0.68                | 4.67                | 5,675                      | 467                         | 6,142                      | $6.14 | ฿203 | 9,883                       | $0.10                    |

This evaluation itself made 9,094 provider calls (6,068 IndexFaces, 1,296 SearchFacesByImage, 1,042 SearchFaces, 652 DeleteFaces).

## Failure analysis (recommended pipeline at 91 / 87)

| What                                                                              | Count |
| --------------------------------------------------------------------------------- | ----- |
| Appearances missed, returned below FACE_MAYBE (a lower threshold would find them) | 60    |
| Appearances missed, not returned at all (face not indexed, or too dissimilar)     | 36    |
| Wrong photos in "ใช่คุณ"                                                          | 2     |
| Persons with at least one wrong "ใช่คุณ" photo                                    | 2     |
| Wrong photos in "อาจจะเป็นคุณ"                                                    | 24    |
| Present persons with zero results                                                 | 0     |
| … of whom no selfie had a detectable face                                         | 0     |
| Selfies without a detectable face                                                 | 0     |
| Scans where a call hit MaxFaces (results may be cut off)                          | 0     |

Synthetic only: strong+maybe recall by face width in the original photo and by pose.

| Face width    | Appearances | Found | Recall |
| ------------- | ----------- | ----- | ------ |
| < 1% of width | 0           | 0     | –      |
| 1–2%          | 71          | 4     | 5.6%   |
| 2–4%          | 146         | 120   | 82.2%  |
| 4–8%          | 97          | 94    | 96.9%  |
| ≥ 8%          | 20          | 20    | 100.0% |

| Pose  | Appearances | Found | Recall |
| ----- | ----------- | ----- | ------ |
| front | 226         | 173   | 76.5%  |
| left  | 47          | 28    | 59.6%  |
| right | 61          | 37    | 60.7%  |

## Appendix: every option at its own operating point

| Option                       | FACE_STRONG | FACE_MAYBE | Targets met | Strong P | Strong R | Strong+maybe P | Strong+maybe R | Strong+maybe F1 | Macro R | Zero-result | Calls / 1,000 photos |
| ---------------------------- | ----------- | ---------- | ----------- | -------- | -------- | -------------- | -------------- | --------------- | ------- | ----------- | -------------------- |
| `le1600-low-never/s1-x0`     | 92          | 91         | yes         | 100.0%   | 6.0%     | 95.5%          | 6.3%           | 11.8%           | 6.3%    | 45.5%       | 1,100                |
| `le1600-low-never/s3-x0`     | 92          | 90         | yes         | 100.0%   | 6.0%     | 90.3%          | 8.4%           | 15.3%           | 8.4%    | 36.4%       | 1,300                |
| `le1600-low-never/s1-x2`     | 92          | 91         | yes         | 100.0%   | 7.5%     | 92.9%          | 7.8%           | 14.4%           | 8.2%    | 45.5%       | 1,171                |
| `le1600-low-never/s3-x2`     | 92          | 91         | yes         | 100.0%   | 7.5%     | 93.8%          | 9.0%           | 16.4%           | 9.2%    | 40.9%       | 1,371                |
| `le1600-low-signal/s1-x0`    | 92          | 91         | yes         | 100.0%   | 7.5%     | 91.7%          | 9.9%           | 17.8%           | 10.3%   | 27.3%       | 2,758                |
| `le1600-low-signal/s3-x0`    | 92          | 91         | yes         | 100.0%   | 9.9%     | 93.0%          | 12.0%          | 21.2%           | 12.3%   | 27.3%       | 2,958                |
| `le1600-low-signal/s1-x2`    | 92          | 91         | yes         | 100.0%   | 10.5%    | 93.8%          | 13.5%          | 23.6%           | 14.2%   | 27.3%       | 2,837                |
| `le1600-low-signal/s3-x2`    | 92          | 91         | yes         | 100.0%   | 12.6%    | 94.3%          | 15.0%          | 25.8%           | 15.5%   | 27.3%       | 3,058                |
| `le1600-low-always/s1-x0`    | 91          | 89         | yes         | 100.0%   | 22.5%    | 91.5%          | 29.0%          | 44.1%           | 29.1%   | 0.0%        | 5,775                |
| `le1600-low-always/s3-x0`    | 91          | 90         | yes         | 98.9%    | 26.0%    | 91.0%          | 30.2%          | 45.4%           | 30.3%   | 0.0%        | 5,975                |
| `le1600-low-always/s1-x2`    | 92          | 89         | yes         | 100.0%   | 26.9%    | 93.2%          | 37.1%          | 53.1%           | 37.2%   | 0.0%        | 5,904                |
| `le1600-low-always/s3-x2`    | 91          | 89         | yes         | 98.3%    | 35.0%    | 90.6%          | 43.4%          | 58.7%           | 43.6%   | 0.0%        | 6,138                |
| `le1600-medium-never/s1-x0`  | 92          | 90         | yes         | 100.0%   | 4.5%     | 91.7%          | 6.6%           | 12.3%           | 6.6%    | 40.9%       | 1,100                |
| `le1600-medium-never/s3-x0`  | 92          | 90         | yes         | 100.0%   | 5.4%     | 90.9%          | 9.0%           | 16.3%           | 9.0%    | 36.4%       | 1,300                |
| `le1600-medium-never/s1-x2`  | 92          | 90         | yes         | 100.0%   | 6.9%     | 93.5%          | 8.7%           | 15.9%           | 8.9%    | 40.9%       | 1,163                |
| `le1600-medium-never/s3-x2`  | 92          | 90         | yes         | 100.0%   | 7.5%     | 92.3%          | 10.8%          | 19.3%           | 11.1%   | 36.4%       | 1,367                |
| `le1600-medium-signal/s1-x0` | 91          | 91         | yes         | 100.0%   | 10.5%    | 100.0%         | 10.5%          | 19.0%           | 10.7%   | 31.8%       | 2,958                |
| `le1600-medium-signal/s3-x0` | 91          | 91         | yes         | 100.0%   | 12.9%    | 100.0%         | 12.9%          | 22.8%           | 12.9%   | 27.3%       | 3,158                |
| `le1600-medium-signal/s1-x2` | 91          | 91         | yes         | 98.1%    | 15.9%    | 98.1%          | 15.9%          | 27.3%           | 16.1%   | 31.8%       | 3,058                |
| `le1600-medium-signal/s3-x2` | 91          | 91         | yes         | 100.0%   | 17.7%    | 100.0%         | 17.7%          | 30.0%           | 17.8%   | 27.3%       | 3,267                |
| `le1600-medium-always/s1-x0` | 92          | 90         | yes         | 100.0%   | 20.4%    | 93.5%          | 25.7%          | 40.4%           | 25.9%   | 0.0%        | 5,758                |
| `le1600-medium-always/s3-x0` | 92          | 90         | yes         | 100.0%   | 24.0%    | 91.8%          | 30.2%          | 45.5%           | 30.7%   | 0.0%        | 5,958                |
| `le1600-medium-always/s1-x2` | 92          | 89         | yes         | 100.0%   | 26.9%    | 90.8%          | 38.3%          | 53.9%           | 38.5%   | 0.0%        | 5,892                |
| `le1600-medium-always/s3-x2` | 92          | 90         | yes         | 100.0%   | 29.3%    | 92.6%          | 37.7%          | 53.6%           | 37.6%   | 0.0%        | 6,104                |
| `le2400-low-never/s1-x0`     | 91          | 88         | yes         | 100.0%   | 14.1%    | 90.0%          | 24.3%          | 38.2%           | 24.8%   | 0.0%        | 1,100                |
| `le2400-low-never/s3-x0`     | 91          | 89         | yes         | 100.0%   | 16.2%    | 92.1%          | 24.6%          | 38.8%           | 25.1%   | 0.0%        | 1,300                |
| `le2400-low-never/s1-x2`     | 91          | 88         | yes         | 100.0%   | 20.4%    | 91.7%          | 29.6%          | 44.8%           | 29.9%   | 0.0%        | 1,217                |
| `le2400-low-never/s3-x2`     | 91          | 89         | yes         | 100.0%   | 21.0%    | 92.6%          | 29.9%          | 45.2%           | 30.2%   | 0.0%        | 1,433                |
| `le2400-low-signal/s1-x0`    | 92          | 89         | yes         | 100.0%   | 17.1%    | 92.2%          | 28.1%          | 43.1%           | 28.0%   | 4.5%        | 2,525                |
| `le2400-low-signal/s3-x0`    | 92          | 89         | yes         | 100.0%   | 23.4%    | 90.8%          | 35.3%          | 50.9%           | 35.5%   | 4.5%        | 2,725                |
| `le2400-low-signal/s1-x2`    | 92          | 89         | yes         | 100.0%   | 26.0%    | 93.0%          | 39.5%          | 55.5%           | 39.2%   | 4.5%        | 2,658                |
| `le2400-low-signal/s3-x2`    | 92          | 89         | yes         | 100.0%   | 29.0%    | 91.6%          | 42.5%          | 58.1%           | 42.3%   | 4.5%        | 2,867                |
| `le2400-low-always/s1-x0`    | 91          | 89         | yes         | 98.1%    | 30.5%    | 92.6%          | 41.0%          | 56.8%           | 41.4%   | 0.0%        | 5,792                |
| `le2400-low-always/s3-x0`    | 92          | 89         | yes         | 100.0%   | 34.1%    | 92.3%          | 50.3%          | 65.1%           | 51.1%   | 0.0%        | 5,992                |
| `le2400-low-always/s1-x2`    | 91          | 89         | yes         | 98.7%    | 45.2%    | 93.0%          | 56.0%          | 69.9%           | 55.6%   | 0.0%        | 5,942                |
| `le2400-low-always/s3-x2`    | 91          | 89         | yes         | 98.2%    | 49.1%    | 93.0%          | 59.9%          | 72.9%           | 59.7%   | 0.0%        | 6,150                |
| `le2400-medium-never/s1-x0`  | 92          | 89         | yes         | 100.0%   | 12.3%    | 94.4%          | 20.1%          | 33.1%           | 20.3%   | 13.6%       | 1,100                |
| `le2400-medium-never/s3-x0`  | 92          | 89         | yes         | 100.0%   | 15.3%    | 94.0%          | 23.7%          | 37.8%           | 24.2%   | 9.1%        | 1,300                |
| `le2400-medium-never/s1-x2`  | 92          | 88         | yes         | 100.0%   | 18.0%    | 91.7%          | 29.6%          | 44.8%           | 29.8%   | 0.0%        | 1,217                |
| `le2400-medium-never/s3-x2`  | 92          | 89         | yes         | 100.0%   | 19.8%    | 95.1%          | 29.0%          | 44.5%           | 29.2%   | 9.1%        | 1,433                |
| `le2400-medium-signal/s1-x0` | 90          | 89         | yes         | 99.0%    | 28.7%    | 93.9%          | 32.3%          | 48.1%           | 32.9%   | 4.5%        | 2,842                |
| `le2400-medium-signal/s3-x0` | 90          | 89         | yes         | 99.2%    | 35.9%    | 92.5%          | 40.4%          | 56.3%           | 41.2%   | 0.0%        | 3,042                |
| `le2400-medium-signal/s1-x2` | 91          | 88         | yes         | 100.0%   | 39.2%    | 90.8%          | 56.0%          | 69.3%           | 55.3%   | 4.5%        | 2,992                |
| `le2400-medium-signal/s3-x2` | 90          | 88         | yes         | 98.2%    | 47.9%    | 90.7%          | 61.1%          | 73.0%           | 60.9%   | 0.0%        | 3,217                |
| `le2400-medium-always/s1-x0` | 90          | 88         | yes         | 98.4%    | 36.8%    | 91.0%          | 45.5%          | 60.7%           | 45.6%   | 0.0%        | 5,775                |
| `le2400-medium-always/s3-x0` | 90          | 88         | yes         | 98.7%    | 45.8%    | 90.2%          | 55.1%          | 68.4%           | 55.7%   | 0.0%        | 5,975                |
| `le2400-medium-always/s1-x2` | 91          | 87         | yes         | 98.8%    | 50.9%    | 90.2%          | 71.3%          | 79.6%           | 71.1%   | 0.0%        | 5,938                |
| `le2400-medium-always/s3-x2` | 91          | 88         | yes         | 99.4%    | 52.1%    | 91.2%          | 68.0%          | 77.9%           | 68.1%   | 0.0%        | 6,142                |
| `le3500-low-never/s1-x0`     | 89          | 86         | yes         | 98.3%    | 34.4%    | 90.7%          | 44.0%          | 59.3%           | 44.1%   | 0.0%        | 1,100                |
| `le3500-low-never/s3-x0`     | 89          | 87         | yes         | 98.6%    | 42.8%    | 92.0%          | 47.9%          | 63.0%           | 48.8%   | 0.0%        | 1,300                |
| `le3500-low-never/s1-x2`     | 91          | 86         | yes         | 100.0%   | 42.2%    | 91.5%          | 54.5%          | 68.3%           | 55.1%   | 0.0%        | 1,254                |
| `le3500-low-never/s3-x2`     | 90          | 87         | yes         | 98.8%    | 50.6%    | 91.7%          | 56.0%          | 69.5%           | 57.0%   | 0.0%        | 1,483                |
| `le3500-low-signal/s1-x0`    | 90          | 88         | yes         | 99.1%    | 33.5%    | 92.5%          | 44.0%          | 59.6%           | 44.1%   | 0.0%        | 2,608                |
| `le3500-low-signal/s3-x0`    | 90          | 88         | yes         | 99.3%    | 42.8%    | 92.6%          | 52.4%          | 66.9%           | 53.1%   | 0.0%        | 2,808                |
| `le3500-low-signal/s1-x2`    | 90          | 87         | yes         | 98.9%    | 54.2%    | 90.2%          | 68.9%          | 78.1%           | 69.5%   | 0.0%        | 2,775                |
| `le3500-low-signal/s3-x2`    | 90          | 88         | yes         | 99.0%    | 56.6%    | 92.3%          | 65.0%          | 76.3%           | 65.3%   | 0.0%        | 2,988                |
| `le3500-low-always/s1-x0`    | 90          | 88         | yes         | 99.2%    | 38.0%    | 90.3%          | 44.6%          | 59.7%           | 44.7%   | 0.0%        | 5,792                |
| `le3500-low-always/s3-x0`    | 90          | 88         | yes         | 98.7%    | 46.1%    | 90.4%          | 53.3%          | 67.0%           | 54.0%   | 0.0%        | 5,992                |
| `le3500-low-always/s1-x2`    | 90          | 88         | yes         | 99.0%    | 58.4%    | 91.9%          | 68.3%          | 78.4%           | 68.5%   | 0.0%        | 5,971                |
| `le3500-low-always/s3-x2`    | 90          | 88         | yes         | 99.0%    | 58.1%    | 91.0%          | 66.5%          | 76.8%           | 66.7%   | 0.0%        | 6,175                |
| `le3500-medium-never/s1-x0`  | 88          | 85         | yes         | 98.4%    | 37.1%    | 90.8%          | 47.0%          | 61.9%           | 47.7%   | 0.0%        | 1,100                |
| `le3500-medium-never/s3-x0`  | 88          | 86         | yes         | 98.1%    | 45.2%    | 93.1%          | 48.2%          | 63.5%           | 49.4%   | 0.0%        | 1,300                |
| `le3500-medium-never/s1-x2`  | 89          | 86         | yes         | 98.8%    | 48.2%    | 94.1%          | 52.7%          | 67.6%           | 53.9%   | 0.0%        | 1,271                |
| `le3500-medium-never/s3-x2`  | 89          | 86         | yes         | 98.8%    | 50.6%    | 92.1%          | 52.7%          | 67.0%           | 54.0%   | 0.0%        | 1,483                |
| `le3500-medium-signal/s1-x0` | 91          | 87         | yes         | 100.0%   | 29.9%    | 90.7%          | 49.4%          | 64.0%           | 49.8%   | 0.0%        | 2,842                |
| `le3500-medium-signal/s3-x0` | 90          | 88         | yes         | 98.0%    | 44.0%    | 92.7%          | 53.0%          | 67.4%           | 53.8%   | 0.0%        | 3,042                |
| `le3500-medium-signal/s1-x2` | 91          | 87         | yes         | 100.0%   | 42.5%    | 92.1%          | 66.2%          | 77.0%           | 65.7%   | 0.0%        | 2,992                |
| `le3500-medium-signal/s3-x2` | 91          | 87         | yes         | 100.0%   | 47.0%    | 90.5%          | 68.6%          | 78.0%           | 68.5%   | 0.0%        | 3,204                |
| `le3500-medium-always/s1-x0` | 90          | 87         | yes         | 100.0%   | 37.1%    | 90.7%          | 52.7%          | 66.7%           | 52.9%   | 0.0%        | 5,775                |
| `le3500-medium-always/s3-x0` | 90          | 88         | yes         | 99.4%    | 45.8%    | 90.1%          | 54.5%          | 67.9%           | 55.2%   | 0.0%        | 5,975                |
| `le3500-medium-always/s1-x2` | 90          | 87         | yes         | 99.5%    | 54.8%    | 90.3%          | 70.1%          | 78.9%           | 70.2%   | 0.0%        | 5,946                |
| `le3500-medium-always/s3-x2` | 90          | 88         | yes         | 99.5%    | 54.2%    | 91.1%          | 64.7%          | 75.7%           | 65.0%   | 0.0%        | 6,150                |
