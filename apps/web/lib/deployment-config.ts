/**
 * Deployment-specific inputs: where this app is reachable. Everything here
 * comes from the environment so the same build runs in any account or network.
 */

const LOCAL_BASE_URL = "http://localhost:3000";
const NEXT_BUILD_PHASE = "phase-production-build";

type Env = Record<string, string | undefined>;

export type DeploymentConfig = {
  publicBaseUrl: string | null;
  internalBaseUrl: string | null;
  problems: string[];
};

/** Pure reader so the rules can be tested without reloading the module. */
export function readDeploymentConfig(env: Env): DeploymentConfig {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";

  let publicBaseUrl: string | null = null;
  const rawPublic = env.NEXTAUTH_URL?.trim();
  if (rawPublic) {
    publicBaseUrl = parseBaseUrl(rawPublic);
    if (!publicBaseUrl) {
      problems.push("NEXTAUTH_URL must be an absolute http(s) URL");
    }
  } else if (production) {
    problems.push("NEXTAUTH_URL is required in production");
  } else {
    publicBaseUrl = LOCAL_BASE_URL;
  }

  let internalBaseUrl: string | null = null;
  const rawInternal = env.INTERNAL_BASE_URL?.trim();
  if (rawInternal) {
    internalBaseUrl = parseBaseUrl(rawInternal);
    if (!internalBaseUrl) {
      problems.push("INTERNAL_BASE_URL must be an absolute http(s) URL");
    }
  }

  if (env.BEDROCK_CLIENT === "real" && !env.AWS_REGION?.trim()) {
    problems.push("AWS_REGION is required when BEDROCK_CLIENT=real");
  }

  return { publicBaseUrl, internalBaseUrl, problems };
}

function parseBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const config = readDeploymentConfig(process.env);

/**
 * Public origin of the deployed app, without a trailing slash. This must NOT
 * be derived from `req.url` or `Host` headers; those can point at the internal
 * container bind address and leak bad redirects into Location headers we send
 * to browsers.
 *
 * There is no fallback origin in production: a missing or malformed
 * NEXTAUTH_URL fails at load. `next build` evaluates route modules without the
 * runtime environment, so the build phase alone gets the local placeholder.
 */
export const PUBLIC_BASE_URL: string = resolvePublicBaseUrl();

function resolvePublicBaseUrl(): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  if (process.env.NEXT_PHASE === NEXT_BUILD_PHASE) return LOCAL_BASE_URL;
  throw new Error(
    `Invalid deployment configuration: ${config.problems
      .filter((problem) => problem.startsWith("NEXTAUTH_URL"))
      .join("; ")}`,
  );
}

/**
 * Address of this app on the private network, when the deployment has one.
 * A malformed value reads as null here (so the internal host is refused) and
 * is reported by `assertDeploymentConfig()` at boot.
 */
export const INTERNAL_BASE_URL: string | null = config.internalBaseUrl;

/**
 * The address a server-side caller (worker, AgentCore runtime) uses to reach
 * this app. Anything a browser follows must keep using `PUBLIC_BASE_URL`.
 */
export function serverCallbackBaseUrl(): string {
  return INTERNAL_BASE_URL ?? PUBLIC_BASE_URL;
}

/** True for the public host and, when configured, the internal host. */
export function isAllowedAppHost(host: string): boolean {
  const candidate = host.trim().toLowerCase();
  if (!candidate) return false;
  if (candidate === new URL(PUBLIC_BASE_URL).host.toLowerCase()) return true;
  return (
    INTERNAL_BASE_URL !== null &&
    candidate === new URL(INTERNAL_BASE_URL).host.toLowerCase()
  );
}

/** Throws one error naming every missing or malformed variable. */
export function assertDeploymentConfig(env: Env = process.env): void {
  const { problems } = readDeploymentConfig(env);
  if (problems.length > 0) {
    throw new Error(`Invalid deployment configuration: ${problems.join("; ")}`);
  }
}
