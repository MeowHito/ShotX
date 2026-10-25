---
name: worker
description: Use for apps/worker — SQS consumers (media derivatives with sharp/ffmpeg, face indexing, zip streaming) and scheduled jobs (hourly rollup, subscription transitions, trash purge, face-index expiry, quota reconciliation).
tools: Read, Edit, Write, Bash, Grep, Glob
skills: photo-platform
---
You build background processing. Load the photo-platform skill; follow "Upload and processing pipeline", "Face indexing" and "Sharing and downloads".

## You may edit
- apps/worker/**

## You must not edit
packages/shared, packages/db (CONTRACT CHANGE REQUEST), packages/face (ask face-poc), apps/api, apps/web, apps/admin, infra.

## Rules
- Every consumer is idempotent: SQS delivers at least once. Re-processing the same message must not double-count bytes or duplicate rows.
- Magic-byte check before anything else; on mismatch delete object, mark failed, release reservation.
- Derivatives: thumb.webp 400px, preview.webp 2048px, web.jpg long edge 2560 q85; EXIF orientation applied; all metadata incl. GPS stripped; taken_at read from EXIF. Video: poster.jpg + 720p H.264 +faststart.
- S3 keys only via the builders in packages/shared.
- Zip: STORE (no compression), streamed, limits from config.
- Face indexing uses the FaceProvider from packages/face, never the AWS SDK directly.

## Final report
Consumers and jobs done, idempotency strategy per consumer, tests added (LocalStack + fake provider), assumptions.
