import {
  BedrockAgentCoreClient,
  GetResourceApiKeyCommand,
} from "@aws-sdk/client-bedrock-agentcore";

interface ApiKeyClient {
  send(command: GetResourceApiKeyCommand): Promise<{ apiKey?: string }>;
}

/**
 * AgentCore Runtime delivers this exact payload header when user identity is
 * present. Node lowercases incoming header keys, so the lookup uses the
 * normalized form below. Contract:
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
 */
export const AGENTCORE_WORKLOAD_ACCESS_TOKEN_HEADER = "WorkloadAccessToken";
const NODE_WORKLOAD_ACCESS_TOKEN_HEADER =
  AGENTCORE_WORKLOAD_ACCESS_TOKEN_HEADER.toLowerCase();

export function createAgentCoreApiKeyProvider({
  workloadAccessToken,
  providerName,
  region,
  client,
}: {
  workloadAccessToken?: string;
  providerName?: string;
  region?: string;
  client?: ApiKeyClient;
}): () => Promise<string | undefined> {
  let resolved: string | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (!workloadAccessToken?.trim()) {
      throw new Error(
        "AgentCore web-search credentials are unavailable because the workload identity token is missing.",
      );
    }
    if (!providerName?.trim()) {
      throw new Error(
        "AgentCore web-search credentials are unavailable because the credential provider is not configured.",
      );
    }

    if (resolved) return resolved;
    pending ??= loadApiKey({
      workloadAccessToken: workloadAccessToken.trim(),
      providerName: providerName.trim(),
      region,
      client,
    })
      .then((apiKey) => {
        resolved = apiKey;
        return apiKey;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

export function readWorkloadAccessToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[NODE_WORKLOAD_ACCESS_TOKEN_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

async function loadApiKey({
  workloadAccessToken,
  providerName,
  region,
  client,
}: {
  workloadAccessToken: string;
  providerName: string;
  region?: string;
  client?: ApiKeyClient;
}): Promise<string> {
  const identity =
    client ??
    (new BedrockAgentCoreClient(
      region ? { region } : {},
    ) as unknown as ApiKeyClient);
  let response: { apiKey?: string };
  try {
    response = await identity.send(
      new GetResourceApiKeyCommand({
        workloadIdentityToken: workloadAccessToken,
        resourceCredentialProviderName: providerName,
      }),
    );
  } catch {
    throw new Error(
      "AgentCore web-search credential retrieval failed. Search is temporarily unavailable.",
    );
  }
  const apiKey = response.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "AgentCore web-search credential retrieval returned no key. Search is temporarily unavailable.",
    );
  }
  return apiKey;
}
