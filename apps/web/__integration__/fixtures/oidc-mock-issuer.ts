import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local OpenID Connect issuer for tests: discovery document, signing keys,
 * a token endpoint that checks the client secret, the redirect URI and the
 * PKCE verifier before signing an ID token, and userinfo. It listens on
 * 127.0.0.1 only and never reaches the network.
 *
 * There is no login page. A test plays the browser: it takes the
 * authorization URL the app produced, hands it to `authorize()` with the
 * claims the person "signed in" with, and gets back the code to return to
 * the app's callback.
 */

export type Claims = Record<string, unknown>;

export interface AuthorizeOptions {
  /** ID token claims, on top of iss / aud / iat / exp / nonce. */
  claims: Claims;
  /** Userinfo answer for this sign-in. Defaults to `{ sub }`. */
  userinfo?: Claims;
  /** Sign the ID token with a key the issuer does not publish. */
  forgedSignature?: boolean;
  /** Put a different nonce in the ID token than the app asked for. */
  wrongNonce?: boolean;
}

interface PendingCode {
  redirectUri: string;
  nonce: string | null;
  codeChallenge: string | null;
  options: AuthorizeOptions;
}

export interface OidcMockIssuer {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Requests seen, as `METHOD /path`, in order. */
  requests: string[];
  /** Play the sign-in page: returns the `code` for the app's callback. */
  authorize(authorizationUrl: string, options: AuthorizeOptions): string;
  close(): Promise<void>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Claims, key: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64url(JSON.stringify(payload));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${body}`)
    .sign(key);
  return `${header}.${body}.${base64url(signature)}`;
}

export async function startOidcMockIssuer(): Promise<OidcMockIssuer> {
  const kid = "test-key";
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const unpublished = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clientId = "comparative-test-client";
  const clientSecret = `test-secret-${randomUUID()}`;
  const codes = new Map<string, PendingCode>();
  const userinfoByToken = new Map<string, Claims>();
  const requests: string[] = [];
  let issuer = "";

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    requests.push(`${req.method} ${url.pathname}`);

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (url.pathname === "/jwks") {
      return json(res, 200, {
        keys: [
          {
            ...signing.publicKey.export({ format: "jwk" }),
            kid,
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    }

    if (url.pathname === "/userinfo") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const claims = userinfoByToken.get(token);
      return claims
        ? json(res, 200, claims)
        : json(res, 401, { error: "invalid_token" });
    }

    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const basic = Buffer.from(
          (req.headers.authorization ?? "").replace(/^Basic /, ""),
          "base64",
        ).toString();
        const expected = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
        if (basic !== expected) {
          return json(res, 401, { error: "invalid_client" });
        }
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        if (
          !pending ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("redirect_uri") !== pending.redirectUri ||
          !pending.codeChallenge ||
          createHash("sha256").update(verifier).digest("base64url") !==
            pending.codeChallenge
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }

        const { options } = pending;
        const now = Math.floor(Date.now() / 1000);
        const accessToken = randomUUID();
        userinfoByToken.set(
          accessToken,
          options.userinfo ?? { sub: options.claims.sub },
        );
        return json(res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          id_token: signJwt(
            {
              iss: issuer,
              aud: clientId,
              iat: now,
              exp: now + 300,
              nonce: options.wrongNonce ? "not-the-nonce" : pending.nonce,
              ...options.claims,
            },
            options.forgedSignature
              ? unpublished.privateKey
              : signing.privateKey,
            kid,
          ),
        });
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    requests,
    authorize(authorizationUrl, options) {
      const url = new URL(authorizationUrl);
      if (
        url.origin !== issuer ||
        url.pathname !== "/authorize" ||
        url.searchParams.get("client_id") !== clientId ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        throw new Error("not an authorization request for this issuer");
      }
      const code = randomUUID();
      codes.set(code, {
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        nonce: url.searchParams.get("nonce"),
        codeChallenge: url.searchParams.get("code_challenge"),
        options,
      });
      return code;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
