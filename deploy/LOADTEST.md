# Post-race face-search load test

ADR 0008 makes one VPS a single point of failure with no autoscaling, and face search is
self-hosted (ADR 0009): every scan runs face detection and embedding (ONNX, YuNet + the
recogniser) on the api's CPU, then a pgvector search in Postgres. Nothing is billed per call, so
the limit is the VPS. Load-test the post-race spike before launch with
`loadtest/face-search.k6.js` ([k6](https://k6.io)).

**Never against production.** Every scan writes consents and activity events. Use a staging copy:
the same VPS size and compose file, its own R2 bucket and database. The script refuses to run
unless `PRODUCTION_HOST` is set and differs from `BASE_URL`, and `I_AM_SURE_THIS_IS_STAGING=yes`.

## Data

- **Photos:** one real-size event, at least 5,000 photos with face indexing on, uploaded to staging
  through the normal pipeline (the face-eval event if the photographer's licence allows it).
- **Selfies:** 20–30 consenting volunteers, as `deploy/loadtest/selfies/selfie-01.jpg`… on the
  operator's machine only. They are biometric data: git-ignored, never uploaded anywhere else,
  deleted after the test.
- **Shares:** 1–5 folder shares in `gallery` mode, tokens passed as `SHARE_TOKENS`.

## Before the run

- Per-IP limits: `FACE_SEARCH_RATE_PER_IP` (10 per 10 min) stops one load generator at once. Run
  k6 from many source IPs, or raise the per-IP limit **on staging only** and say so in the
  report. Keep the per-share and per-viewer limits as in production.
- Captcha: Cloudflare's always-pass Turnstile test keys on staging, so a rate-limit hit shows up
  as `face_search_rate_limited`, not a stuck challenge.
- Note the face settings under test (`FACE_ONNX_THREADS`, `FACE_INFERENCE_CONCURRENCY`, `API_CPUS`)
  and the baseline host CPU and memory.

## Steps

| run         | arrival rate (scans/s)    | hold         | goal                                              |
| ----------- | ------------------------- | ------------ | ------------------------------------------------- |
| 1. smoke    | 1                         | 2 min        | the script, consent and search work end to end    |
| 2. baseline | 5                         | 10 min       | latency at a typical event                        |
| 3. spike    | ramp to 20 in 3 min       | 10 min       | the post-race peak (about 12,000 scans in 10 min) |
| 4. ceiling  | keep raising 20 → 40 → 60 | until errors | where it breaks, and what breaks first            |
| 5. soak     | 5                         | 60 min       | memory growth in api, Redis memory                |

```sh
k6 run -e BASE_URL=https://staging.photos.example.com -e PRODUCTION_HOST=photos.example.com \
  -e I_AM_SURE_THIS_IS_STAGING=yes -e SHARE_TOKENS=$TOKENS -e SELFIE_COUNT=25 \
  -e RATE_WARM=2 -e RATE_PEAK=20 -e HOLD=10m deploy/loadtest/face-search.k6.js
```

Upload a folder of 500 photos during the spike, so the worker's indexing and sharp/ffmpeg compete
for CPU the way they do after a race.

## What to watch

- **api CPU** (`docker stats`): inference is CPU-bound, so this saturates first. Note whether
  more `FACE_INFERENCE_CONCURRENCY` or `FACE_ONNX_THREADS` helps or only adds queueing.
- **Latency:** `face_search_duration` p50/p95/p99 and `http_req_failed`.
- **RATE_LIMITED share:** `face_search_rate_limited` against all scans (and
  `face_search_unavailable`); a high share at the expected peak means the limits, not the CPU,
  decide what people see.
- api memory against `API_MEMORY` (selfies stay in memory, up to `FACE_SEARCH_MAX_BODY_BYTES` per
  request in flight) and restarts (`docker compose ps`); Postgres CPU and slow statements (the
  vector search); Redis memory against `REDIS_MAXMEMORY`. Swap stays off.

Pass criteria (confirm with the owner): p95 under 4 s and under 1 % errors at the expected peak,
no container restart. Report the ceiling and the first resource to saturate: that decides the VPS
size, `API_CPUS`, the face concurrency settings and the worker's CPU share.

## After

Delete the volunteers' selfies, then wipe the staging consents, activity events and face vectors
(or the whole staging database).
