/**
 * NextAuth v4 session cookies from Node stdlib (#696).
 *
 * Mirrors `next-auth/jwt` `encode`: HKDF-SHA256(secret, salt "", info
 * "NextAuth.js Generated Encryption Key", 32 bytes) → compact JWE with
 * `{alg:"dir",enc:"A256GCM"}`. `apps/web/__tests__/load-stats.test.ts`
 * decodes a minted token with the real `next-auth/jwt` to keep this honest.
 * Token claims match what `apps/web/e2e/helpers/auth.ts` installs, so the
 * app's `jwt` callback resolves the user by `ghSub` (ping_subject).
 */
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";

export function deriveEncryptionKey(secret) {
  return Buffer.from(
    hkdfSync("sha256", secret, "", "NextAuth.js Generated Encryption Key", 32),
  );
}

/**
 * @param {Buffer} key from deriveEncryptionKey
 * @param {{id:string,pingSubject:string,role:string,email:string,displayName:string}} user
 */
export function mintSessionToken(key, user, maxAgeSeconds = 2 * 60 * 60) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.pingSubject,
    ghSub: user.pingSubject,
    userId: user.id,
    role: user.role,
    email: user.email,
    name: user.displayName,
    iat: now,
    exp: now + maxAgeSeconds,
    jti: randomUUID(),
  };
  const header = Buffer.from(JSON.stringify({ alg: "dir", enc: "A256GCM" })).toString("base64url");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return `${header}..${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

/** Cookie name follows next-auth's secure-prefix rule for https origins. */
export function sessionCookie(baseUrl, token) {
  const name =
    baseUrl.protocol === "https:"
      ? "__Secure-next-auth.session-token"
      : "next-auth.session-token";
  return `${name}=${token}`;
}
