const ROUTE_TEMPLATES: Array<[RegExp, string]> = [
  [/^\/invite\/[^/]+$/, "/invite/[token]"],
  [/^\/admin\/runs\/[^/]+$/, "/admin/runs/[id]"],
  [/^\/apps\/manage\/[^/]+$/, "/apps/manage/[id]"],
  [/^\/apps\/[^/]+$/, "/apps/[slug]"],
  [/^\/skills\/[^/]+$/, "/skills/[id]"],
  [/^\/workspace\/artifacts\/[^/]+$/, "/workspace/artifacts/[id]"],
];

export function analyticsPathFor(pathname: string): string {
  if (pathname === "/skills/new") return pathname;

  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(pathname)) return template;
  }
  return pathname;
}
