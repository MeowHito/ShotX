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
RUN pnpm install --frozen-lockfile --filter @shotx/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @shotx/api run build \
 && pnpm --filter @shotx/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
# RDS CA bundle for PGSSLMODE=verify-full. The directory is created first: ADD/COPY --chmod
# would apply the file mode to the /etc/ssl directories too and break OpenSSL's config lookup.
RUN install -d -m 755 /etc/ssl/certs
COPY --from=build /tmp/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
