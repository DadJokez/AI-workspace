# Viewer-scoped app widgets

The live binding endpoint executes using the signed-in viewer's own access.
Each binding is independent. A missing GitHub connection does not substitute
the author's data or prevent a connected Salesforce widget from refreshing.
Publication defaults and existing access checks are unchanged (#805).

## Response contract

`GET /api/apps/{appId}/data/{bindingId}` accepts a declared binding ID only,
never browser-supplied tool arguments. Pinned arguments stay on the server.

| State | Fields | HTTP |
| --- | --- | --- |
| `ok` | `ok: true`, `data`, `fetchedAt` (server ISO timestamp), binding/provider/tool identifiers | 200 |
| `needs_connection` | `ok: false`, `needsConnection: true`, `provider`, `connectUrl`, `connectionStatus` | 200 |
| `error` | `ok: false`, `scopedMessage`, legacy error code | Existing 404, 422, 429, or 502 |

`fetchedAt` means this binding completed fetching, not that its upstream
records were modified at that time. Responses are private and `no-store`.
Errors never include provider exception text, pinned arguments, or fallback
data. Missing and unauthorized apps still return the same 404 response.
Authentication middleware may return 401 without the binding contract;
the client normalizes that into a sign-in message for the affected widget.
Legacy success fields (`records`, `totalSize`, `done`) remain available for
existing Salesforce pages alongside `data`.

## Rendering

Live app pages receive `window.comparativeData` before their own scripts.
`refresh(bindingId)` returns one of the states above and normalizes network,
malformed-response, and HTTP failures into `error`. New widgets should use
`refreshWidget(bindingId, element, renderData)`:

```html
<section id="pipeline" aria-label="My pipeline"></section>
<script>
  function renderPipeline(data) {
    const list = document.createElement('ul');
    for (const row of data.records) {
      const item = document.createElement('li');
      item.textContent = row.Name;
      list.append(item);
    }
    return list;
  }
  window.comparativeData.refreshWidget(
    'soql-1', document.getElementById('pipeline'), renderPipeline
  );
</script>
```

The helper clears the target **before** fetching, shows only returned data,
appends a local-time freshness label with an ISO `time[datetime]`, or renders
the provider connection link/scoped error. It also catches renderer failures
and ignores older in-flight responses after a newer refresh has started.
Renderers return a Node or plain text (optionally via a Promise); they must
not mutate other containers. Never use `innerHTML` for upstream text, inline
builder data as fallback, or run a page-wide fallback on one failed widget.

The connection link opens Settings > Integrations in another tab so the
viewer can connect and return to refresh the app. It uses a fixed same-origin
path, not an upstream-supplied URL. The persistent publication badge explains
that others may see different numbers; it supports light/dark themes and
wraps on narrow screens.

This supplies the #805 contract and renderer. Existing authored pages that
call `refresh` retain their own rendering responsibility. Generalized
authoring, bake detection, and preview-as-unconnected remain #804; this does
not silently rewrite previously published HTML or change its data mode.

## Coverage

- Route tests: mixed provider states, viewer identity, cache headers, server
  freshness, sanitized failures, unchanged authorization and audit checks.
- Token-handler tests: real route/executor/bootstrap composition; credentials
  remain server-side for successful, unconnected, and failing reads.
- `e2e/app-data-widgets.spec.ts`: actual injected client in desktop/mobile
  Chromium; both themes, freshness, network/JSON/auth failures, and racing
  refreshes. Provider responses are fixtures, not live third-party accounts.
