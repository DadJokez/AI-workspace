import { assertDeploymentConfig } from "@/lib/deployment-config";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    assertDeploymentConfig();
    // Node-only module: loaded here so the edge build never sees it.
    const { logOutboundProxyOnce } = await import(
      "@ai-workspace/agent/outbound-proxy"
    );
    logOutboundProxyOnce();
  }
}
