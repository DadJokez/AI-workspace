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
The client retains known legacy error codes/messages and an allowlisted
`connectionStatus`. It derives error fields from HTTP status, never copies
an upstream error body, and normalizes unknown connection states to
`not_connected`. New consumers should use the tri-state contract.

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
Renderers return one Node or plain text (optionally via a Promise), including
empty-data branches. Arrays and undefined are invalid; strings are not parsed
as HTML. Build a detached list/table or DocumentFragment and return its root;
do not mutate the widget or other containers in the callback. Never use `innerHTML` for upstream text, inline
builder data as fallback, or run a page-wide fallback on one failed widget.

The connection link opens Settings > Integrations in another tab so the
viewer can connect and return to refresh the app. It uses a fixed same-origin
path, not an upstream-supplied URL. The persistent publication badge explains
that others may see different numbers; it supports light/dark themes and
wraps on narrow screens.

Existing authored pages that call `refresh` retain their own rendering
responsibility. These changes do not silently rewrite previously published
HTML or change its data mode.

## Authoring safeguards (#804)

Successful connected read calls can mint generic bindings for GitHub, Google,
Notion and Salesforce. Generic calls require a successful receipt and an enabled,
read-only, always-allowed catalog entry, using the runtime's exact tool-name
encoder. Ambiguous names and oversized arguments are skipped. Salesforce SOQL
keeps its existing validated `soql-N` contract; other bindings use `data-N`.
The immutable metadata holds pinned arguments; the client sees identifiers only.
Revising a matched artifact without new calls retains that version's bindings,
never bindings from an unrelated file. Publish/fetch policy checks still apply.

Post-call usage notes tell the model to render through `refreshWidget`, not
embed connected records, and include the native tool name and a callback
example. Detailed API instructions use the existing just-in-time channel.
A short preamble capability note, only when a supported provider is mounted,
directs the model to read the connected tool instead of inventing browser SDK
or OAuth setup. Authored renderers must match the
actual provider response shape; generic tool output is not necessarily a
Salesforce-style `records` object.

At save, successful connected provenance plus a large inline script data
structure produces a **possible embedded data** warning, even if bindings are
also present. The heuristic currently looks for scripts of at least 500
characters with eight object keys. It can flag UI configuration and miss data
in other encodings or plain markup. Absence of the warning is **not** proof of
safe sharing. Provenance covers the minting turn and a matched prior artifact;
unrelated historical chat files are not swept into a new artifact.

An author can choose **Make live in chat** to send a conversion request with an
explicit reference to this version in the current chat. It is a model task,
not deterministic conversion, automatic publication or a permission change.
Review the new artifact before publishing. Existing secret scans still run.

**Preview as unconnected viewer** installs the same widget helper with all
declared bindings forced to `needs_connection`. The sandbox has no account or
real app id and blocks network requests, external assets and forms. This is a
local simulation, not impersonation; pages depending on external libraries may
look different. Static copies outside managed widgets remain visible so the
author can detect them. Turning it off restores the ordinary artifact preview.
The live-sharing default (#803), credentials, IAM and environment are unchanged.

## Coverage

- Route tests: mixed provider states, viewer identity, cache headers, server
  freshness, sanitized failures, unchanged authorization and audit checks.
- Token-handler tests: real route/executor/bootstrap composition; credentials
  remain server-side for successful, unconnected, and failing reads.
- `e2e/app-data-widgets.spec.ts`: actual injected client in desktop/mobile
  Chromium; both themes, freshness, network/JSON/auth failures, and racing
  refreshes. Provider responses are fixtures, not live third-party accounts.
- `__tests__/app-data-authoring.test.ts` and `e2e/app-data-authoring.spec.ts`:
  catalog-filtered minting, metadata scrubbing, warning provenance, scoped
  conversion, and a network-blocked unconnected preview on desktop/mobile.

### Authoring model probe (2026-09-07)

Five GitHub and five Google fixture-tool turns ran through the real Sonnet 4.5
runtime with the production preamble and post-call notes. All ten final samples
called the fixture tool, returned complete named HTML, used `refreshWidget`,
and omitted the fixture records from the source. Chromium rendered each saved
HTML unchanged twice: all 20 connected/unconnected checks passed. Connected
views showed both records, a freshness timestamp, and a second request after
Refresh; unconnected views showed the provider CTA with zero data requests.
This verifies model authoring with fixture responses, not live third-party
credentials or publication.

Earlier probes exposed prefixed binding names, callbacks returning undefined,
and invented Google client OAuth setup. The final guidance addresses those
failures; the raw failures remain in the audit evidence. A temporary observer's
100 ms refresh assumption falsely failed one final sample with a 300 ms button
delay. Replaying all ten saved samples with a bounded request-based wait passed
without regenerating or modifying their HTML. This did not change any nightly
judge, rubric, marker, or assertion.
