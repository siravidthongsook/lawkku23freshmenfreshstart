# E-Ticket web (Next.js prod). Build context = repo root so ../src shared schemas resolve.
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# deps layer cached on web lockfile
FROM base AS deps
COPY web/package.json web/pnpm-lock.yaml* ./web/
RUN cd web && (pnpm install --frozen-lockfile || pnpm install)

# build: needs both web/ and src/ (turbopack root pinned to repo root in next.config.ts)
FROM base AS build
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY src ./src
COPY web ./web
RUN cd web && pnpm build

# runner: reuse build image, start Next on 3001 (matches `next start -p 3001`)
FROM build AS runner
ENV NODE_ENV=production
WORKDIR /app/web
EXPOSE 3001
CMD ["pnpm", "start"]
