import { ANALYTICS } from "@/lib/deployment-config";

/** Same-origin path the browser SDK posts to; the route below proxies it. */
export const POSTHOG_INGEST_PATH = "/ingest";

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-encoding",
  "content-type",
  "user-agent",
];
const FORWARDED_RESPONSE_HEADERS = ["cache-control", "content-type", "etag"];

/**
 * PostHog Cloud serves the SDK's static files from a sibling host
 * (`us.i.posthog.com` -> `us-assets.i.posthog.com`). Any other host serves
 * both itself.
 */
export function postHogUpstreamUrl(
  host: string,
  path: string[],
  search: string,
): string {
  const upstream = new URL(host);
  const cloud = /^(us|eu)\.i\.posthog\.com$/.exec(upstream.hostname);
  if (cloud && (path[0] === "static" || path[0] === "array")) {
    upstream.hostname = `${cloud[1]}-assets.i.posthog.com`;
  }
  upstream.pathname = `/${path.map(encodeURIComponent).join("/")}`;
  upstream.search = search;
  return upstream.toString();
}

/**
 * Proxies one analytics request to the configured host. 404 when analytics is
 * off. Cookies and authorization never leave: only the listed headers do.
 */
export async function proxyPostHogIngest(
  req: Request,
  path: string[],
): Promise<Response> {
  if (!ANALYTICS) return new Response(null, { status: 404 });

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(
      postHogUpstreamUrl(ANALYTICS.host, path, new URL(req.url).search),
      {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        redirect: "manual",
      },
    );
  } catch {
    return new Response(null, { status: 502 });
  }

  // fetch has already decoded the body, so its encoding and length headers
  // would be wrong; pass on only what still describes it.
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
