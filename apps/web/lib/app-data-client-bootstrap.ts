import type { PublicDataBinding } from "@/lib/app-data-bindings";
import { APP_DATA_CONNECT_URL } from "@/lib/app-data-response";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";

/**
 * The injected script: a data-only contract for model-authored pages.
 * `window.__COMPARATIVE_APP__` carries the app id and the SCRUBBED binding
 * list (never query text), and `window.comparativeData.refresh(bindingId)`
 * fetches the viewer-scoped endpoint with the viewer's own session cookie.
 * JSON is serialized with `<` escaped so author-controlled labels can never
 * break out of the script element.
 */
export function buildAppDataBootstrap(
  appId: string,
  bindings: readonly PublicDataBinding[],
  previewUnconnected = false,
): string {
  const payload = JSON.stringify({ appId, bindings }).replace(/</g, "\\u003c");
  const providerNames = JSON.stringify(INTEGRATION_DISPLAY_NAMES);
  return [
    "<script>",
    `window.__COMPARATIVE_APP__ = ${payload};`,
    `(function () {
  var app = window.__COMPARATIVE_APP__;
  var providerNames = ${providerNames};
  var connectUrl = ${JSON.stringify(APP_DATA_CONNECT_URL)};
  var pending = new WeakMap();
  function error(message, code, legacyMessage) {
    return { state: 'error', ok: false, scopedMessage: message,
      error: code || 'refresh_failed', message: legacyMessage || message };
  }
  async function refresh(bindingId) {
    var binding = app.bindings.find(function (binding) { return binding.id === bindingId; });
    if (!binding) {
      return error('This data is unavailable.', 'not_found');
    }
    ${previewUnconnected ? "return { state: 'needs_connection', ok: false, needsConnection: true, provider: binding.provider, connectionStatus: 'not_connected', connectUrl: connectUrl };" : ""}
    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(app.appId) + '/data/' + encodeURIComponent(bindingId), {
        credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }
      });
      if (!res.ok) {
        // Preserve known legacy fields without trusting an upstream error body.
        var codes = { 401: 'unauthorized', 404: 'not_found', 422: 'invalid_binding',
          429: 'rate_limited', 502: 'data_source_error' };
        var message = res.status === 401 ? 'Sign in to refresh this data.' :
          res.status === 429 ? 'Too many refreshes. Try again shortly.' : 'This data could not be refreshed.';
        return error(message, codes[res.status],
          res.status === 502 ? 'The data source could not be reached.' : message);
      }
      var body = await res.json();
      if (body.state === 'ok' && body.ok === true && typeof body.fetchedAt === 'string' &&
          Number.isFinite(Date.parse(body.fetchedAt)) && Object.prototype.hasOwnProperty.call(body, 'data')) return body;
      if (body.state === 'needs_connection' && typeof body.provider === 'string') {
        var statuses = ['not_connected', 'connector_disabled', 'pending_approval',
          'reconnect_required', 'temporarily_unavailable', 'execution_not_configured', 'unsupported_provider'];
        return { state: 'needs_connection', ok: false, needsConnection: true,
          provider: body.provider, connectUrl: connectUrl,
          connectionStatus: statuses.includes(body.connectionStatus) ? body.connectionStatus : 'not_connected' };
      }
      return error('This data could not be refreshed.');
    } catch (_) {
      return error('This data could not be refreshed.');
    }
  }
  async function refreshWidget(bindingId, element, renderData) {
    // Clear first: neither stale viewer data nor mint-time data is a fallback.
    var request = {};
    pending.set(element, request);
    element.replaceChildren();
    element.setAttribute('aria-busy', 'true');
    var result = await refresh(bindingId);
    if (pending.get(element) !== request) return result;
    try {
      if (result.state === 'ok') {
        var content = await renderData(result.data);
        if (pending.get(element) !== request) return result;
        if (!(content instanceof Node) && typeof content !== 'string') throw new Error('Invalid widget content');
        var time = document.createElement('time');
        time.dateTime = result.fetchedAt;
        time.textContent = 'Fetched ' + new Date(result.fetchedAt).toLocaleString();
        time.style.cssText = 'display:block;font:12px/1.5 system-ui;letter-spacing:0;margin-top:8px';
        element.replaceChildren(content, time);
      } else if (result.state === 'needs_connection') {
        var link = document.createElement('a');
        link.href = result.connectUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Connect ' + (providerNames[result.provider] || result.provider);
        element.replaceChildren(link);
      } else {
        element.textContent = result.scopedMessage;
      }
    } catch (_) {
      result = error('This data widget could not be displayed.');
      if (pending.get(element) === request) element.textContent = result.scopedMessage;
    } finally {
      if (pending.get(element) === request) element.removeAttribute('aria-busy');
    }
    return result;
  }
  window.comparativeData = { refresh: refresh, refreshWidget: refreshWidget };
})();`,
    "</script>",
  ].join("\n");
}

/**
 * Insert the bootstrap so it runs before any page script: after the opening
 * <head> tag when one exists, otherwise prepended to the document.
 */
export function injectAppDataBootstrap(html: string, bootstrap: string): string {
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}\n${bootstrap}${html.slice(at)}`;
  }
  return `${bootstrap}\n${html}`;
}

/** Isolated simulation: no app id, session, provider call, or colleague identity. */
export function buildUnconnectedAppPreview(html: string, bindings: readonly PublicDataBinding[]): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
  // Prepend before authored markup, including any authored head/base/scripts.
  return policy + buildAppDataBootstrap("unconnected-preview", bindings, true) + html;
}
