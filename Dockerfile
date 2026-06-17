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
# run migrations then start
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]
