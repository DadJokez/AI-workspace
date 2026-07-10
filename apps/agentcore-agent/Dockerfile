# AI Hub agent loop for Amazon Bedrock AgentCore Runtime (specs/003 spike).
# AgentCore requires linux/arm64. Build from the REPO ROOT so workspace
# packages resolve:
#
#   docker build \
#     -f apps/agentcore-agent/Dockerfile \
#     -t <account>.dkr.ecr.<region>.amazonaws.com/ai-workspace-agentcore-agent:latest \
#     --push .
ARG NODE_VERSION=20-bookworm-slim
FROM public.ecr.aws/docker/library/node:${NODE_VERSION}

RUN corepack enable

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agent ./packages/agent
COPY apps/agentcore-agent ./apps/agentcore-agent

RUN pnpm install --frozen-lockfile --filter "@ai-workspace/agentcore-agent..."

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "--filter", "@ai-workspace/agentcore-agent", "start"]
