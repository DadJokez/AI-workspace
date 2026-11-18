import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDeploymentConfig } from "@/lib/deployment-config";

/**
 * OIDC_CLIENT_SECRET stays on the server. It is read in exactly two places
 * (presence check in the deployment config, value where the provider is
 * built), no client component can reach either module, and the settings the
 * browser receives are built without it.
 */

const WEB_ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["app", "components", "lib"];
const SERVER_ONLY_AUTH_MODULES = [
  "@/lib/deployment-config",
  "@/lib/auth/nextauth",
  "@/lib/auth/oidc-sign-in",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const files = [
  ...SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(WEB_ROOT, dir))),
  path.join(WEB_ROOT, "middleware.ts"),
  path.join(WEB_ROOT, "instrumentation.ts"),
  path.join(WEB_ROOT, "instrumentation-client.ts"),
].map((file) => ({
  name: path.relative(WEB_ROOT, file),
  text: readFileSync(file, "utf8"),
}));

describe("OIDC client secret", () => {
  it("is named only where it is checked and where the provider is built", () => {
    expect(
      files
        .filter((file) => file.text.includes("OIDC_CLIENT_SECRET"))
        .map((file) => file.name)
        .sort(),
    ).toEqual(["lib/auth/nextauth.ts", "lib/deployment-config.ts"]);
  });

  it("cannot be imported into a client component", () => {
    const clientFiles = files.filter((file) =>
      /^\s*["']use client["']/.test(file.text),
    );
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(
      clientFiles
        .filter((file) =>
          SERVER_ONLY_AUTH_MODULES.some((module) => file.text.includes(module)),
        )
        .map((file) => file.name),
    ).toEqual([]);
  });

  it("is not part of the settings object or of what the browser is sent", () => {
    const secret = "oidc-client-secret-value";
    const config = readDeploymentConfig({
      AUTH_PROVIDERS: "pingone",
      OIDC_ISSUER: "https://sso.example",
      OIDC_CLIENT_ID: "comparative",
      OIDC_CLIENT_SECRET: secret,
    });
    expect(config.auth.oidc).not.toBeNull();
    expect(JSON.stringify(config)).not.toContain(secret);

    // Neither the browser's settings type nor the layout that fills it
    // mentions sign-in configuration at all.
    for (const name of ["lib/public-runtime-config.ts", "app/layout.tsx"]) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file, name).toBeDefined();
      expect(file?.text, name).not.toMatch(/oidc|client_secret/i);
    }
  });
});
