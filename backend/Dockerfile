# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY backend/package.json ./
RUN npm install --include=dev

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./
RUN npx prisma generate
RUN npx nest build
RUN npm prune --omit=dev
RUN npm install @prisma/client prisma

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl tini
ENV NODE_ENV=production
ENV PORT=4000

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node --enable-source-maps dist/main"]
