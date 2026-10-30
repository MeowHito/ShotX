# syntax=docker/dockerfile:1.7
#
# ShotX worker: SQS consumers (media, faces, zip) and scheduled jobs.
# Build from the repository root (the pnpm workspace):
#
#   docker buildx build --platform linux/arm64 -f apps/worker/Dockerfile -t shotx-worker .
#
# Fargate runs it on ARM64 (infra/cdk.json services.cpuArchitecture; CI builds with --platform
# linux/arm64); the VPS builds it for its own architecture. The build stage bundles the
# worker (and the TypeScript of its workspace packages) into dist/main.js with esbuild; the runtime
# image runs that with plain node (no tsx) and holds only production node_modules. It ships ffmpeg
# (video posters and previews) and the RDS CA bundle that NODE_EXTRA_CA_CERTS points at, so
# PGSSLMODE=verify-full works. Apps/worker/Dockerfile.dockerignore keeps the context small.

ARG NODE_VERSION=24.11
ARG PNPM_VERSION=12.3.4

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install --global "pnpm@${PNPM_VERSION}" && npm cache clean --force
WORKDIR /repo

# --- Build: all dependencies of @shotx/worker, bundle, then a production-only deploy ----------
FROM base AS build
# Manifests first so dependency layers cache across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/face/package.json packages/face/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shotx/worker..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/face packages/face
COPY apps/worker apps/worker
# Face models (ADR 0009): fetched for FACE_DETECTOR_MODEL / FACE_MODEL (build args, registry
# defaults when empty) and checked against the registry's SHA-256; the provider checks again.
ARG FACE_DETECTOR_MODEL=
ARG FACE_MODEL=
# Models before `deploy --prod`, which prunes the dev tools (tsx) from the workspace; afterwards
# ONNX Runtime keeps only the binary for this image's platform (it ships every OS, ~250 MB).
RUN pnpm --filter @shotx/worker run build \
 && FACE_DETECTOR_MODEL="$FACE_DETECTOR_MODEL" FACE_MODEL="$FACE_MODEL" \
    pnpm --filter @shotx/worker exec tsx ../../packages/face/src/cli/download-models.ts --dir /models \
 && pnpm --filter @shotx/worker deploy --legacy --prod /out \
 && cp -r apps/worker/dist /out/dist \
 && mv /models /out/models \
 && ORT=/out/node_modules/onnxruntime-node/bin/napi-v6 \
 && ARCH=$(case "$(uname -m)" in aarch64) echo arm64;; *) echo x64;; esac) \
 && find "$ORT" -mindepth 2 -maxdepth 2 -type d ! -path "$ORT/linux/$ARCH" -exec rm -rf {} + \
 && test -d "$ORT/linux/$ARCH"

# --- Runtime ---------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# ffmpeg (with libx264 and AAC) for videos; tini forwards SIGTERM so the worker can release its
# in-flight messages (visibility 0) within WORKER_SHUTDOWN_GRACE_SECONDS (ECS stopTimeout is that
# plus 10 s).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ffmpeg ca-certificates curl tini \
 && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      --output /etc/ssl/certs/rds-global-bundle.pem \
 && grep -q 'BEGIN CERTIFICATE' /etc/ssl/certs/rds-global-bundle.pem \
 && apt-get purge --yes curl && apt-get autoremove --yes \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    WORKER_TMP_DIR=/tmp/worker \
    FACE_MODEL_DIR=/app/models \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/models ./models
RUN mkdir -p /tmp/worker && chown node:node /tmp/worker

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
