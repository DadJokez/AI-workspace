# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20-alpine

FROM public.ecr.aws/docker/library/node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/cursor-runtime/package.json packages/cursor-runtime/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-servers/package.json packages/mcp-servers/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm --filter @ai-workspace/web build

FROM public.ecr.aws/docker/library/node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=build --chown=nextjs:nextjs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nextjs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
