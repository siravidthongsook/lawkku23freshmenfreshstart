# LawKKUFreshmenFreshStart23 backend. tsx runtime (no compile step) — internal app, keep it simple.
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# deps layer cached on lockfile
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# runtime image
FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# private file storage volume mount point
RUN mkdir -p /data/storage
EXPOSE 3000
# start only; migrations run as an explicit deploy step (see deploy.yml).
# `pnpm start` preloads ./src/lib/otel.ts via tsx --import (see package.json).
CMD ["pnpm", "start"]
