import { assertDeploymentConfig } from "@/lib/deployment-config";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    assertDeploymentConfig();
  }
}
