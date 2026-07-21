# syntax=docker/dockerfile:1.7

# Runtime Node must track a supported LTS (#459). The CodeBuild *host* still
# runs Node 20 (buildspec.yml) because its console-owned image lacks 24 — that
# host only drives docker/cdk and is tracked in #467.
ARG NODE_VERSION=24-alpine

FROM public.ecr.aws/docker/library/node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/agent-runtime/node_modules ./packages/agent-runtime/node_modules
COPY . .
RUN pnpm --filter @ai-workspace/web build

FROM base AS migrator
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages/db/package.json packages/db/tsconfig.json packages/db/drizzle.config.ts packages/db/
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
CMD ["pnpm", "--filter", "@ai-workspace/db", "db:migrate"]

FROM base AS worker
ENV NODE_ENV=production
# CodeBuild runs the authenticated production smoke from this worker image with
# tsx, so the worker target intentionally carries the full workspace install.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/agent/node_modules ./packages/agent/node_modules
COPY --from=deps /repo/packages/agent-runtime/node_modules ./packages/agent-runtime/node_modules
COPY --from=deps /repo/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY . .
CMD ["pnpm", "--filter", "@ai-workspace/web", "worker:chat-runs"]

FROM worker AS memory-worker
CMD ["pnpm", "--filter", "@ai-workspace/web", "worker:memory-capture"]

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
