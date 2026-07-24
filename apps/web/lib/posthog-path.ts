const STATIC_ROUTES = new Set([
  "/",
  "/admin",
  "/admin/apps",
  "/admin/audit",
  "/admin/feedback",
  "/admin/runs",
  "/admin/tools",
  "/admin/usage",
  "/apps",
  "/chat",
  "/e2e/chat",
  "/login",
  "/skills",
  "/skills/new",
]);

const ROUTE_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/invite\/[^/]+$/, "/invite/[token]"],
  [/^\/admin\/runs\/[^/]+$/, "/admin/runs/[id]"],
  [/^\/apps\/manage\/[^/]+$/, "/apps/manage/[id]"],
  [/^\/apps\/[^/]+$/, "/apps/[slug]"],
  [/^\/skills\/[^/]+$/, "/skills/[id]"],
  [/^\/workspace\/artifacts\/[^/]+$/, "/workspace/artifacts/[id]"],
];

export function analyticsPathFor(pathname: string): string {
  let normalizedPath: string;
  try {
    normalizedPath = new URL(pathname, "https://analytics.invalid").pathname;
  } catch {
    return "/[redacted]";
  }

  if (normalizedPath.length > 1 && normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  if (STATIC_ROUTES.has(normalizedPath)) return normalizedPath;

  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(normalizedPath)) return template;
  }

  // New routes remain private until explicitly classified above.
  return "/[redacted]";
}
