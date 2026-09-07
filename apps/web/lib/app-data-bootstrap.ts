import type { ToolCall, ToolResult } from "@ai-workspace/agent";
import {
  LEGACY_SOQL_PROVIDER,
  LEGACY_SOQL_TOOL_NAME,
  MAX_DATA_BINDINGS,
  type DataBinding,
  type PublicDataBinding,
} from "@/lib/app-data-bindings";
import { validateReadOnlySoql } from "@/lib/salesforce/api";
import { APP_DATA_CONNECT_URL } from "@/lib/app-data-response";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";

/**
 * Live-data app client wiring (#407, second half). Server-only:
 * - derive pinned bindings from the run_soql calls a minting turn actually
 *   ran (authoring auto-emit — "share as live app" without asking), and
 * - inject the in-page bootstrap that lets a served app call its own data
 *   endpoint under the viewer's session.
 */

const RUN_SOQL_TOOL = "salesforce__run_soql";

/**
 * Bindings for a servable artifact, derived from the minting turn's
 * successful run_soql calls. Failed calls are skipped (their query returned
 * nothing the page could have rendered), duplicates collapse to the first
 * occurrence, every query must still pass read-only validation, and the
 * list caps at MAX_DATA_BINDINGS in call order.
 */
export function deriveBindingsFromTurnTools(
  toolCalls: readonly ToolCall[] | undefined,
  toolResults: readonly ToolResult[] | undefined,
): DataBinding[] {
  if (!toolCalls?.length) return [];
  const failed = new Set(
    (toolResults ?? [])
      .filter((result) => result.isError)
      .map((result) => result.toolCallId),
  );
  const bindings: DataBinding[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== RUN_SOQL_TOOL) continue;
    if (failed.has(call.id)) continue;
    const soql = (call.input as { soql?: unknown })?.soql;
    if (typeof soql !== "string") continue;
    let query: string;
    try {
      query = validateReadOnlySoql(soql);
    } catch {
      continue;
    }
    if (seen.has(query)) continue;
    seen.add(query);
    // Emitted on the generic #802 shape; ids keep the `soql-N` contract the
    // run_soql usage notes promise page authors.
    bindings.push({
      id: `soql-${bindings.length + 1}`,
      provider: LEGACY_SOQL_PROVIDER,
      toolName: LEGACY_SOQL_TOOL_NAME,
      pinnedArgs: { soql: query },
    });
    if (bindings.length >= MAX_DATA_BINDINGS) break;
  }
  return bindings;
}

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
  function error(message) {
    return { state: 'error', ok: false, scopedMessage: message };
  }
  async function refresh(bindingId) {
    if (!app.bindings.some(function (binding) { return binding.id === bindingId; })) {
      return error('This data is unavailable.');
    }
    try {
      var res = await fetch('/api/apps/' + encodeURIComponent(app.appId) + '/data/' + encodeURIComponent(bindingId), {
        credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }
      });
      if (!res.ok) {
        return error(res.status === 401 ? 'Sign in to refresh this data.' :
          res.status === 429 ? 'Too many refreshes. Try again shortly.' : 'This data could not be refreshed.');
      }
      var body = await res.json();
      if (body.state === 'ok' && body.ok === true && typeof body.fetchedAt === 'string' &&
          Number.isFinite(Date.parse(body.fetchedAt)) && Object.prototype.hasOwnProperty.call(body, 'data')) return body;
      if (body.state === 'needs_connection' && typeof body.provider === 'string') {
        return { state: 'needs_connection', ok: false, needsConnection: true,
          provider: body.provider, connectUrl: connectUrl };
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
