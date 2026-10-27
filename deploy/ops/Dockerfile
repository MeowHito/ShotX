# syntax=docker/dockerfile:1.7
#
# ShotX ops image for the VPS (deploy/docker-compose.yml): `migrate`, `backup` and `monitor`.
# Build from the repository root:
#   docker build -f deploy/ops/Dockerfile -t shotx/ops .
# It runs the TypeScript of deploy/ops with tsx (the deploy package's own dependencies), and
# ships pg_dump 18 (PGDG) and age for the encrypted backups. deploy/ops/Dockerfile.dockerignore
# keeps env files and other secrets out of the build context.

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl gnupg age tini \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install --yes --no-install-recommends postgresql-client-18 \
 && apt-get purge --yes curl gnupg && apt-get autoremove --yes \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /repo
# Manifests first so dependency layers cache across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY deploy/package.json deploy/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shotx/deploy..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY deploy/ops deploy/ops
COPY deploy/tsconfig.json deploy/
# The ops-state volume (backup status) takes this directory's owner when Docker first creates it.
RUN chown -R node:node /repo/deploy && install -d -o node -g node -m 750 /var/lib/shotx-ops
USER node
WORKDIR /repo/deploy
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx", "ops/cli.ts"]
