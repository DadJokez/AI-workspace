# AI Hub agent loop for Amazon Bedrock AgentCore Runtime (specs/003 spike).
# AgentCore requires linux/arm64. Build from the REPO ROOT so workspace
# packages resolve:
#
#   docker build \
#     -f apps/agentcore-agent/Dockerfile \
#     -t <account>.dkr.ecr.<region>.amazonaws.com/ai-workspace-agentcore-agent:latest \
#     --push .
ARG NODE_VERSION=24-bookworm-slim
# The base image is pinned by digest: a tag can be moved to another image, a
# digest cannot. This is the multi-platform index public.ecr.aws served for
# node:24-bookworm-slim on 2026-11-18; Docker ignores the tag once a digest is
# given, so change NODE_VERSION and NODE_IMAGE_DIGEST together, and raise the
# digest to take base-image security fixes.
ARG NODE_IMAGE_DIGEST=sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# A registry mirror that carries the same image replaces the public registry.
ARG BASE_IMAGE_REGISTRY=public.ecr.aws/docker/library
FROM ${BASE_IMAGE_REGISTRY}/node:${NODE_VERSION}@${NODE_IMAGE_DIGEST}

# An npm registry mirror, for networks that cannot reach registry.npmjs.org.
# Unset, nothing changes: pnpm and corepack use their defaults.
ARG PNPM_REGISTRY=""
RUN corepack enable
RUN if [ -n "$PNPM_REGISTRY" ]; then \
      COREPACK_NPM_REGISTRY="$PNPM_REGISTRY" pnpm config set registry "$PNPM_REGISTRY"; \
    fi

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm patchedDependencies (root package.json) must be present for any
# frozen-lockfile install — the lockfile pins each patch file's hash.
COPY patches ./patches
COPY packages/agent ./packages/agent
COPY apps/agentcore-agent ./apps/agentcore-agent

RUN pnpm install --frozen-lockfile --filter "@ai-workspace/agentcore-agent..."

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "--filter", "@ai-workspace/agentcore-agent", "start"]
