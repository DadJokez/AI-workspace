import type { PublicDataBinding } from "@/lib/app-data-bindings";
import { APP_DATA_CONNECT_URL } from "@/lib/app-data-response";

export const GENERATED_CONTENT_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "media-src data: blob:",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
].join("; ");

/** Enforce an opaque origin even when a preview URL is opened directly. */
export const GENERATED_DOCUMENT_CSP = `${GENERATED_CONTENT_CSP}; sandbox allow-scripts; frame-ancestors 'self'`;

export const STUDIO_PREVIEW_CSP = [
  "sandbox allow-scripts", "default-src 'none'",
  "script-src 'unsafe-inline' 'self'", "style-src 'unsafe-inline' 'self'",
  "img-src data: blob: 'self'", "font-src data: 'self'", "media-src data: blob: 'self'",
  "connect-src 'none'", "form-action 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join("; ");

export function isolatedAppShellCsp(hasBindings: boolean): string {
  return [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    "img-src data: blob:", "font-src data:", "media-src data: blob:",
    "frame-src 'self'", `connect-src ${hasBindings ? "'self'" : "'none'"}`,
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
  ].join("; ");
}

/** Only this trusted shell has a workspace origin; authored code never does. */
export function buildIsolatedAppDocument(
  html: string,
  appId: string,
  bindings: readonly PublicDataBinding[],
): string {
  const serialize = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${GENERATED_CONTENT_CSP}">` + html;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Comparative app</title>
<style>html,body{margin:0;height:100%}body{display:flex;flex-direction:column;background:Canvas;color:CanvasText;color-scheme:light dark}iframe{border:0;width:100%;flex:1;min-height:0}nav{padding:8px 12px;font:13px system-ui;border-bottom:1px solid rgba(127,127,127,.3)}nav a{color:inherit;text-underline-offset:3px}</style></head><body>
${bindings.length ? `<nav><a href="${APP_DATA_CONNECT_URL.replace(/&/g, "&amp;")}" target="_blank" rel="noopener noreferrer">Manage data connections</a></nav>` : ""}
<iframe id="app" title="App content" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
(function () {
  const frame = document.getElementById('app');
  const appId = ${serialize(appId)};
  const bindingIds = new Set(${serialize(bindings.map((binding) => binding.id))});
  let active = 0;
  window.addEventListener('message', async function (event) {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const request = event.data;
    const port = event.ports[0];
    if (!port) return;
    if (!request || request.type !== 'comparative:data:refresh' ||
        typeof request.bindingId !== 'string' || !bindingIds.has(request.bindingId)) {
      port.postMessage({ status: 404, body: null }); port.close(); return;
    }
    if (active >= 16) {
      port.postMessage({ status: 429, body: null }); port.close(); return;
    }
    active++;
    try {
      // Neither a URL, provider argument, method nor app id comes from the frame.
      const response = await fetch('/api/apps/' + encodeURIComponent(appId) + '/data/' + encodeURIComponent(request.bindingId), {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000)
      });
      port.postMessage({ status: response.status, body: response.ok ? await response.json() : null });
    } catch (_) {
      port.postMessage({ status: 502, body: null });
    } finally { active--; port.close(); }
  });
  frame.srcdoc = ${serialize(document)};
})();
</script></body></html>`;
}
