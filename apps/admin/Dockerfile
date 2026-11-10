# syntax=docker/dockerfile:1.7
#
# @shotx/admin: Next.js standalone server for ECS Fargate (ARM64, CI builds with --platform
# linux/arm64) and the VPS (deploy/docker-compose.yml, the host's architecture).
# Build from the repository root:
#   docker build --platform linux/arm64 -f apps/admin/Dockerfile -t shotx-admin .
# Runtime configuration comes from the task environment (infra/lib/constructs/services.ts); the
# image holds no stage-specific settings.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version from "packageManager" in the root package.json.
RUN corepack enable
WORKDIR /repo

# Only the workspaces @shotx/admin depends on, with manifests split from sources for layer caching.
FROM base AS prune
COPY . .
RUN npx --yes turbo@2.11.9 prune @shotx/admin --docker

FROM base AS build
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ ./
COPY tsconfig.base.json ./
RUN pnpm --filter @shotx/admin build

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/admin/server.js"]
