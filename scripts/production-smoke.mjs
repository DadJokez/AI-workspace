const DEFAULT_BASE_URL = "https://comparative.builtwithrobot.link";
const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);

const checks = [
  healthCheck,
  loginPageCheck,
  chatRedirectCheck,
  modelsCheck,
  anonymousChatCheck,
];

let failures = 0;

for (const check of checks) {
  const started = Date.now();
  try {
    await check();
    console.log(`ok ${check.name} ${Date.now() - started}ms`);
  } catch (err) {
    failures += 1;
    console.error(`not ok ${check.name}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} production smoke check(s) failed for ${baseUrl}`);
  process.exit(1);
}

console.log(`\nproduction smoke passed for ${baseUrl}`);

async function healthCheck() {
  const response = await fetchWithTimeout("/api/health");
  assertStatus(response, 200, "/api/health");
  const body = await response.json();
  assert(body.status === "ok", "health status is not ok");
  assert(body.checks?.db?.ok === true, "database health check is not ok");
  assert(body.checks?.runtime?.ok === true, "runtime health check is not ok");
  assert(
    JSON.stringify(body).toLowerCase().includes("database_url") === false,
    "health response appears to contain a secret-like DATABASE_URL key",
  );
}

async function loginPageCheck() {
  const response = await fetchWithTimeout("/login");
  assertStatus(response, 200, "/login");
  const html = await response.text();
  assert(html.includes("Comparative"), "login page does not mention Comparative");
  assert(
    html.includes("Sign in") || html.includes("invite-only"),
    "login page does not render sign-in copy",
  );
}

async function chatRedirectCheck() {
  const response = await fetchWithTimeout("/chat", { redirect: "manual" });
  assert(
    response.status >= 300 && response.status < 400,
    `/chat expected redirect, got ${response.status}`,
  );
  const location = response.headers.get("location") ?? "";
  assert(location.includes("/login"), `/chat redirect did not target login: ${location}`);
}

async function modelsCheck() {
  const response = await fetchWithTimeout("/api/models");
  assertStatus(response, 200, "/api/models");
  const body = await response.json();
  assert(typeof body.defaultModelId === "string", "missing defaultModelId");
  assert(Array.isArray(body.models) && body.models.length > 0, "missing model list");
  assert(
    body.models.some((model) => model.id === body.defaultModelId),
    "default model is not present in models list",
  );
}

async function anonymousChatCheck() {
  const response = await fetchWithTimeout("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello from production smoke" }),
  });
  assertStatus(response, 401, "/api/chat anonymous post");
  const body = await response.json();
  assert(body.error === "unauthorized", "anonymous chat did not return unauthorized");
}

function normalizeBaseUrl(raw) {
  return raw.replace(/\/+$/, "");
}

async function fetchWithTimeout(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertStatus(response, expected, label) {
  assert(
    response.status === expected,
    `${label} expected ${expected}, got ${response.status}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
