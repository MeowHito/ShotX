# syntax=docker/dockerfile:1.7
# PostgreSQL 18 (Alpine, like before) with pgvector for face embeddings (ADR 0009 section 4).
# Used by the dev compose (docker-compose.yml), CI and production (deploy/docker-compose.yml).
# Staying on the Alpine base keeps existing data volumes valid: their text collation is musl's,
# and a Debian (glibc) image would order text differently under the same indexes.
#
#   docker build -t shotx/postgres deploy/postgres-image
#
# pgvector is built from a pinned release tarball checked by SHA-256. LLVM bitcode for JIT is
# skipped (with_llvm=no): pgvector's functions don't benefit from it, and it would need the exact
# clang the server was built with.
ARG POSTGRES_IMAGE=postgres:18-alpine
FROM ${POSTGRES_IMAGE}

ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85

RUN set -eux; \
    apk add --no-cache --virtual .pgvector-build build-base curl; \
    curl -fsSL -o /tmp/pgvector.tar.gz \
      "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz"; \
    echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c -; \
    mkdir /tmp/pgvector; \
    tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1; \
    make -C /tmp/pgvector with_llvm=no OPTFLAGS=""; \
    make -C /tmp/pgvector with_llvm=no install; \
    rm -rf /tmp/pgvector /tmp/pgvector.tar.gz; \
    apk del .pgvector-build
