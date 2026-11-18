# syntax=docker/dockerfile:1.7

# Runtime Node must track a supported LTS (#459). The CodeBuild *host* still
# runs Node 20 (buildspec.yml) because its console-owned image lacks 24 — that
# host only drives docker/cdk and is tracked in #467.
ARG NODE_VERSION=24-alpine
# The base image is pinned by digest: a tag can be moved to another image, a
# digest cannot. This is the multi-platform index public.ecr.aws served for
# node:24-alpine on 2026-11-18; Docker ignores the tag once a digest is given,
# so change NODE_VERSION and NODE_IMAGE_DIGEST together, and raise the digest
# to take base-image security fixes.
ARG NODE_IMAGE_DIGEST=sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# A registry mirror that carries the same image replaces the public registry.
ARG BASE_IMAGE_REGISTRY=public.ecr.aws/docker/library

FROM ${BASE_IMAGE_REGISTRY}/node:${NODE_VERSION}@${NODE_IMAGE_DIGEST} AS base
# An npm registry mirror, for networks that cannot reach registry.npmjs.org.
# Unset, nothing changes: pnpm and corepack use their defaults.
ARG PNPM_REGISTRY=""
RUN corepack enable
RUN if [ -n "$PNPM_REGISTRY" ]; then \
      COREPACK_NPM_REGISTRY="$PNPM_REGISTRY" pnpm config set registry "$PNPM_REGISTRY"; \
    fi
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# pnpm patchedDependencies (root package.json) must be present for any
# frozen-lockfile install — the lockfile pins each patch file's hash.
COPY patches ./patches
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
# PostHog analytics config. NEXT_PUBLIC_* vars are inlined by `next build` into
# both the client bundle (instrumentation-client.ts) and the server bundle
# (lib/posthog-server.ts), so they must be present at build time. The project
# token is a public client-side write key, safe to ship in the browser bundle.
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_kCEPkLvyRmDumM57vjp9BLhQvLA5ExQHV4EsFpNogWeb
ENV NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
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

FROM ${BASE_IMAGE_REGISTRY}/node:${NODE_VERSION}@${NODE_IMAGE_DIGEST} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# PostHog analytics config for server-side runtime reads (lib/posthog-server.ts).
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_kCEPkLvyRmDumM57vjp9BLhQvLA5ExQHV4EsFpNogWeb
ENV NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=build --chown=nextjs:nextjs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nextjs /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/scripts/verify-pdf-runtime.mjs ./apps/web/verify-pdf-runtime.mjs

# pdfjs loads its native canvas adapter through createRequire(), which Next's
# file tracer cannot follow. Restore pnpm's package link, then parse a real PDF
# so the image build exercises the lazy canvas and native-binary load path.
RUN set -eux; \
    canvas_dir="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name '@napi-rs+canvas@*' -print -quit)"; \
    pdfjs_dir="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name 'pdfjs-dist@*' -print -quit)"; \
    test -n "$canvas_dir"; \
    test -n "$pdfjs_dir"; \
    mkdir -p "$pdfjs_dir/node_modules/@napi-rs"; \
    if [ ! -e "$pdfjs_dir/node_modules/@napi-rs/canvas" ]; then \
      ln -s "../../../$(basename "$canvas_dir")/node_modules/@napi-rs/canvas" "$pdfjs_dir/node_modules/@napi-rs/canvas"; \
    fi; \
    node ./apps/web/verify-pdf-runtime.mjs; \
    rm ./apps/web/verify-pdf-runtime.mjs

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
