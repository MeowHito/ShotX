# syntax=docker/dockerfile:1.7
# ShotX API. Build from the repository root (the pnpm workspace):
#   docker build -f apps/api/Dockerfile -t shotx-api .
# Multi-arch base images: ECS runs it on ARM64 (Graviton); `--platform linux/arm64` to cross-build.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /tmp/rds-global-bundle.pem
RUN chmod 644 /tmp/rds-global-bundle.pem
# Manifests first so dependency layers cache across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/face/package.json packages/face/
RUN pnpm install --frozen-lockfile --filter @shotx/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/face packages/face
COPY apps/api apps/api
# Face models (ADR 0009): fetched for FACE_DETECTOR_MODEL / FACE_MODEL (build args, registry
# defaults when empty) and checked against the registry's SHA-256; the provider checks again.
ARG FACE_DETECTOR_MODEL=
ARG FACE_MODEL=
# Models before `deploy --prod`, which prunes the dev tools (tsx) from the workspace; afterwards
# ONNX Runtime keeps only the binary for this image's platform (it ships every OS, ~250 MB).
RUN pnpm --filter @shotx/api run build \
 && FACE_DETECTOR_MODEL="$FACE_DETECTOR_MODEL" FACE_MODEL="$FACE_MODEL" \
    pnpm --filter @shotx/api exec tsx ../../packages/face/src/cli/download-models.ts --dir /models \
 && pnpm --filter @shotx/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist \
 && mv /models /out/models \
 && ORT=/out/node_modules/onnxruntime-node/bin/napi-v6 \
 && ARCH=$(case "$(uname -m)" in aarch64) echo arm64;; *) echo x64;; esac) \
 && find "$ORT" -mindepth 2 -maxdepth 2 -type d ! -path "$ORT/linux/$ARCH" -exec rm -rf {} + \
 && test -d "$ORT/linux/$ARCH"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    FACE_MODEL_DIR=/app/models \
    ORT_DISABLE_TELEMETRY=1
# RDS CA bundle for PGSSLMODE=verify-full. The directory is created first: ADD/COPY --chmod
# would apply the file mode to the /etc/ssl directories too and break OpenSSL's config lookup.
RUN install -d -m 755 /etc/ssl/certs
COPY --from=build /tmp/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/models ./models
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
