# Post-race face-search load test

ADR 0008 makes one VPS a single point of failure with no autoscaling. The spec says to load-test
face search for the post-race spike before launch. This is the plan and the script skeleton
(`loadtest/face-search.k6.js`, [k6](https://k6.io)).

**Never against production.** Every scan calls Rekognition, which is billed and counts against the
account's TPS quota, and writes consents and activity events. Use a staging copy: the same VPS
size and compose file, its own R2 bucket, Rekognition collections and database. The script
refuses to run unless `PRODUCTION_HOST` is set and differs from `BASE_URL`, and
`I_AM_SURE_THIS_IS_STAGING=yes`.

## Data

- **Photos:** one real-size event, at least 5,000 photos with face indexing on, uploaded to staging
  through the normal pipeline. Use the face-eval event if the photographer's licence allows it;
  otherwise a staged shoot with volunteers.
- **Selfies:** 20–30 consenting volunteers (the accuracy program's group). Store them as
  `deploy/loadtest/selfies/selfie-01.jpg`… on the operator's machine only. They are biometric
  data: git-ignored, never uploaded anywhere else, deleted after the test.
- **Shares:** 1–5 folder shares in `gallery` mode, tokens passed as `SHARE_TOKENS`.

## Before the run

- Raise the Rekognition TPS quota (`SearchFacesByImage`, `SearchFaces`) in `ap-southeast-1` and set
  `FACE_REKOGNITION_TPS_*` on staging to the granted values. Otherwise the test measures the
  default quota, not the VPS.
- Per-IP limits: `FACE_SEARCH_RATE_PER_IP` (10 per 10 min) would stop one load generator at once.
  Either run k6 from many source IPs (k6 Cloud, or several small VMs), or raise the per-IP limit
  **on staging only** and say so in the report. Keep the per-share and per-viewer limits as in
  production.
- Captcha: `CAPTCHA_PROVIDER=turnstile` with Cloudflare's always-pass test keys on staging, so a
  rate-limit hit shows up as `face_search_rate_limited` instead of a stuck challenge.
- Start the monitor on staging and note the baseline: Redis memory, queue depths, host CPU and
  memory.

## Steps

| run         | arrival rate (scans/s)    | hold         | goal                                              |
| ----------- | ------------------------- | ------------ | ------------------------------------------------- |
| 1. smoke    | 1                         | 2 min        | the script, consent and search work end to end    |
| 2. baseline | 5                         | 10 min       | latency at a typical event                        |
| 3. spike    | ramp to 20 in 3 min       | 10 min       | the post-race peak (about 12,000 scans in 10 min) |
| 4. ceiling  | keep raising 20 → 40 → 60 | until errors | where it breaks, and what breaks first            |
| 5. soak     | 5                         | 60 min       | memory growth in api, Redis memory                |

Example (spike):

```sh
k6 run -e BASE_URL=https://staging.photos.example.com -e PRODUCTION_HOST=photos.example.com \
  -e I_AM_SURE_THIS_IS_STAGING=yes -e SHARE_TOKENS=$TOKENS -e SELFIE_COUNT=25 \
  -e RATE_WARM=2 -e RATE_PEAK=20 -e HOLD=10m deploy/loadtest/face-search.k6.js
```

Run the worker as in production during the test: upload a folder of 500 photos at the same time,
so sharp and ffmpeg compete for CPU the way they do after a race.

## What to record

- k6: `face_search_duration` p50/p95/p99, `http_req_failed`, `face_search_rate_limited`,
  `face_search_unavailable` (Rekognition throttling surfacing as FACE_SEARCH_UNAVAILABLE).
- Host: CPU, memory and load of the VPS (`docker stats`, the monitor's host checks). Swap must
  stay off.
- api: memory against `API_MEMORY` (selfies are held in memory, up to `FACE_SEARCH_MAX_BODY_BYTES`
  per request in flight), event-loop lag, restarts (`docker compose ps`).
- Rekognition: throttling count (CloudWatch `ThrottledCount` on the AWS account).
- Redis: memory against `REDIS_MAXMEMORY` (rate-limit windows and face_only grants).
- Postgres: connections, slow statements (`log_min_duration_statement`).

Pass criteria (confirm with the owner): p95 under 4 s and under 1 % errors at the expected peak,
no container restart, and Redis memory under the alert threshold. Report the ceiling and the
first resource to saturate. That decides the VPS size, `API_CPUS`/`API_MEMORY`, the worker's CPU
share and the Rekognition quota to request.

## After

Delete the volunteers' selfies and the staging collections (`DeleteCollection`). Then wipe the
staging consents and activity events, or the whole staging database.
