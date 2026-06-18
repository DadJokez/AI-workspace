import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "./types";

export const WEB_FETCH_TOOL_NAME = "web__fetch_url";

export const BUILTIN_TOOL_NAMES = [WEB_FETCH_TOOL_NAME] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

const DEFAULT_MAX_BYTES = 64_000;
const MAX_BYTES_CAP = 256_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

interface WebFetchInput {
  url?: unknown;
  maxBytes?: unknown;
}

interface WebFetchOptions {
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof dnsLookup;
  now?: () => Date;
}

export function createBuiltinTools(names: readonly string[] = []): Tool[] {
  const tools: Tool[] = [];
  for (const name of names) {
    if (name === WEB_FETCH_TOOL_NAME) tools.push(createWebFetchTool());
  }
  return tools;
}

export function createWebFetchTool({
  fetchImpl = fetch,
  lookupImpl = dnsLookup,
  now = () => new Date(),
}: WebFetchOptions = {}): Tool {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      "Fetch a public http(s) URL and return readable page text or HTML. Use this when the user asks to inspect, read, summarize, or extract the HTML/source/content of a public web page. Never use it for localhost, private network, link-local, metadata, or credentialed URLs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "The public http(s) URL to fetch.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1024,
          maximum: MAX_BYTES_CAP,
          description:
            "Optional maximum response bytes to read before truncating.",
        },
      },
    },
    async handler(input) {
      const parsedInput = input as WebFetchInput;
      const maxBytes = normalizeMaxBytes(parsedInput.maxBytes);
      const startedAt = now().toISOString();
      const result = await fetchPublicUrl({
        rawUrl: requireUrl(parsedInput.url),
        maxBytes,
        fetchImpl,
        lookupImpl,
      });
      return { ...result, fetchedAt: startedAt };
    },
  };
}

async function fetchPublicUrl({
  rawUrl,
  maxBytes,
  fetchImpl,
  lookupImpl,
}: {
  rawUrl: string;
  maxBytes: number;
  fetchImpl: typeof fetch;
  lookupImpl: typeof dnsLookup;
}) {
  let current = parseAndValidateUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertPublicHostname(current.hostname, lookupImpl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/json,application/xml,text/plain,text/*,*/*;q=0.2",
          "user-agent": "Comparative-URL-Fetch/1.0",
        },
      });
    } catch (err) {
      throw new Error(`URL fetch failed for ${current.toString()}: ${errorText(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `URL fetch failed for ${current.toString()}: redirect ${response.status} had no Location header.`,
        );
      }
      if (redirect === MAX_REDIRECTS) {
        throw new Error(
          `URL fetch failed for ${current.toString()}: too many redirects.`,
        );
      }
      current = parseAndValidateUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextLikeContentType(contentType)) {
      throw new Error(
        `URL fetch failed for ${current.toString()}: content-type "${contentType || "unknown"}" is not readable text or HTML.`,
      );
    }

    const { text, bytesRead, truncated } = await readResponseText(
      response,
      maxBytes,
    );
    return {
      url: current.toString(),
      status: response.status,
      ok: response.ok,
      contentType: contentType || null,
      title: extractHtmlTitle(text),
      bytesRead,
      truncated,
      text,
    };
  }

  throw new Error(`URL fetch failed for ${rawUrl}: too many redirects.`);
}

function requireUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("URL fetch requires a non-empty url string.");
  }
  return value.trim();
}

function parseAndValidateUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL fetch requires a valid URL; received "${rawUrl}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `URL fetch only supports http(s) URLs; received protocol "${url.protocol}".`,
    );
  }
  if (url.username || url.password) {
    throw new Error("URL fetch does not allow embedded credentials in URLs.");
  }
  return url;
}

async function assertPublicHostname(
  hostname: string,
  lookupImpl: typeof dnsLookup,
): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw new Error(`URL fetch blocked private hostname "${hostname}".`);
  }

  const literalIpVersion = isIP(normalized);
  const addresses = literalIpVersion
    ? [{ address: normalized }]
    : await lookupImpl(normalized, { all: true, verbatim: true }).catch((err) => {
        throw new Error(
          `URL fetch could not resolve "${hostname}": ${errorText(err)}`,
        );
      });

  if (addresses.length === 0) {
    throw new Error(`URL fetch could not resolve "${hostname}".`);
  }

  const blocked = addresses.find((entry) => isBlockedIp(entry.address));
  if (blocked) {
    throw new Error(
      `URL fetch blocked private or reserved address "${blocked.address}" for "${hostname}".`,
    );
  }
}

function isBlockedIp(address: string): boolean {
  if (address.includes(":")) return isBlockedIpv6(address);
  return isBlockedIpv4(address);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a === 255) return true;
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (mapped.includes(".")) return isBlockedIpv4(mapped);
    return true;
  }
  return false;
}

function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_BYTES;
  }
  return Math.max(1024, Math.min(MAX_BYTES_CAP, Math.floor(value)));
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("application/json") ||
    normalized.includes("application/xml") ||
    normalized.includes("application/xhtml+xml") ||
    normalized.includes("+json") ||
    normalized.includes("+xml")
  );
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  if (!response.body) return { text: "", bytesRead: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - bytesRead;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      bytesRead += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    bytesRead += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks)),
    bytesRead,
    truncated,
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function extractHtmlTitle(text: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (!match) return null;
  return match[1]!.replace(/\s+/g, " ").trim() || null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "request timed out";
    return err.message;
  }
  return String(err);
}
