# LawKKUFreshmenFreshStart23 web (Next.js prod). Build context = repo root so ../src shared schemas resolve.
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

# web deps layer cached on web lockfile
FROM base AS deps
COPY web/package.json web/pnpm-lock.yaml* web/pnpm-workspace.yaml ./web/
RUN cd web && (pnpm install --frozen-lockfile || pnpm install)

# root deps: shared @be/* schemas under src/ resolve their deps (zod) from /app/node_modules
FROM base AS rootdeps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# build: needs both web/ and src/ (turbopack root pinned to repo root in next.config.ts)
FROM base AS build
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY --from=rootdeps /app/node_modules ./node_modules
COPY src ./src
COPY web ./web
RUN cd web && pnpm build

# runner: reuse build image, start Next on 33490 (matches `next start -p 33490`)
FROM build AS runner
ENV NODE_ENV=production
WORKDIR /app/web
EXPOSE 33490
CMD ["pnpm", "start"]
