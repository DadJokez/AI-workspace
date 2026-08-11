import { lookup as dnsLookup } from "node:dns/promises";
import type * as http from "node:http";
import { BlockList, isIP } from "node:net";
import {
  assertWebEgressAllowed,
  type WebEgressPolicy,
} from "./web-egress-policy";

export type PublicAddress = { address: string; family: number };
export type PublicLookup = NonNullable<http.RequestOptions["lookup"]>;

// Node's BlockList maps IPv4 inputs into IPv6 internally. Keep the families
// separate so the IPv4-mapped IPv6 deny range does not match every IPv4 host.
const PRIVATE_IPV4_BLOCKS = new BlockList();
const PRIVATE_IPV6_BLOCKS = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE_IPV4_BLOCKS.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  PRIVATE_IPV6_BLOCKS.addSubnet(network, prefix, "ipv6");
}

export function parsePublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`A valid public URL is required; received "${rawUrl}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Only public http(s) URLs are supported; received protocol "${url.protocol}".`,
    );
  }
  if (url.username || url.password) {
    throw new Error("Embedded credentials are not allowed in public URLs.");
  }
  const effectivePort = Number(
    url.port || (url.protocol === "https:" ? "443" : "80"),
  );
  const expectedPort = url.protocol === "https:" ? 443 : 80;
  if (effectivePort !== expectedPort) {
    throw new Error(`Public URL port ${effectivePort} is not allowed.`);
  }
  return url;
}

export async function assertPublicUrlAllowed({
  url,
  lookupImpl = dnsLookup,
  egressPolicy,
}: {
  url: URL;
  lookupImpl?: typeof dnsLookup;
  egressPolicy?: WebEgressPolicy;
}): Promise<PublicAddress[]> {
  assertWebEgressAllowed(url.hostname, egressPolicy);
  return resolvePublicAddresses(url.hostname, lookupImpl);
}

export async function resolvePublicAddresses(
  hostname: string,
  lookupImpl: typeof dnsLookup = dnsLookup,
): Promise<PublicAddress[]> {
  const normalized = normalizeHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw new Error(`Blocked private hostname "${hostname}".`);
  }

  const literalIpVersion = isIP(normalized);
  const addresses = literalIpVersion
    ? [{ address: normalized, family: literalIpVersion }]
    : await lookupImpl(normalized, { all: true, verbatim: true }).catch(
        (error) => {
          throw new Error(
            `Could not resolve "${hostname}": ${errorText(error)}.`,
          );
        },
      );

  if (addresses.length === 0) {
    throw new Error(`Could not resolve "${hostname}": no addresses returned.`);
  }

  const guarded = addresses.map((entry) => ({
    address: entry.address,
    family:
      typeof entry.family === "number" ? entry.family : isIP(entry.address),
  }));
  const blocked = guarded.find((entry) => isBlockedPublicTarget(entry.address));
  if (blocked) {
    throw new Error(
      `Blocked private or reserved address "${blocked.address}" for "${hostname}".`,
    );
  }
  return guarded;
}

export function createPublicLookup(
  lookupImpl: typeof dnsLookup = dnsLookup,
  mapError: (error: unknown, hostname: string) => unknown = (error) => error,
): PublicLookup {
  return ((hostname, options, callback) => {
    const done = (typeof options === "function" ? options : callback) as (
      error: NodeJS.ErrnoException | null,
      address?: string | PublicAddress[],
      family?: number,
    ) => void;
    const wantsAll =
      typeof options === "object" && options !== null && Boolean(options.all);

    resolvePublicAddresses(hostname, lookupImpl)
      .then((addresses) => {
        if (wantsAll) {
          done(null, addresses);
          return;
        }
        const first = addresses[0]!;
        done(null, first.address, first.family);
      })
      .catch((error) => done(toErrnoException(mapError(error, hostname))));
  }) as PublicLookup;
}

export function isBlockedPublicTarget(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_IPV4_BLOCKS.check(address, "ipv4");
  if (family === 6) return PRIVATE_IPV6_BLOCKS.check(address, "ipv6");
  return true;
}

/** Safe for receipts: credentials, query values, and fragments never persist. */
export function publicUrlReceipt(rawUrl: string): {
  origin: string;
  displayUrl: string;
} {
  const url = parsePublicHttpUrl(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { origin: url.origin, displayUrl: url.toString() };
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException)
    : (new Error(String(error)) as NodeJS.ErrnoException);
}
