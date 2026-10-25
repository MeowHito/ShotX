# syntax=docker/dockerfile:1.7
#
# @shotx/web: Next.js standalone server for ECS Fargate (ARM64).
# Build from the repository root:
#   docker build --platform linux/arm64 -f apps/web/Dockerfile -t shotx-web .
# Runtime configuration comes from the task environment (infra/lib/constructs/services.ts); the
# image holds no stage-specific settings.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM --platform=linux/arm64 ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version from "packageManager" in the root package.json.
RUN corepack enable
WORKDIR /repo

# Only the workspaces @shotx/web depends on, with manifests split from sources for layer caching.
FROM base AS prune
COPY . .
RUN npx --yes turbo@2.11.9 prune @shotx/web --docker

FROM base AS build
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ ./
COPY tsconfig.base.json ./
RUN pnpm --filter @shotx/web build

FROM --platform=linux/arm64 ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# Self-hosted MediaPipe wasm (scripts/copy-mediapipe.mjs) and any other static files.
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
