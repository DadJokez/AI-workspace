const AUTHORING_NOTE = "If successful read results from this turn are used to build a live HTML dashboard: Comparative pins eligible read calls as server-side bindings. Discover id, provider and toolName through window.__COMPARATIVE_APP__.bindings; arguments stay server-side. Render through window.comparativeData.refreshWidget(binding.id, element, data => a DOM Node or plain string) on load and refresh. Inspect the actual returned structure rather than assuming Salesforce records. Never embed connected records, message bodies or mint-time data in HTML, scripts, fallback markup or local storage. If the bootstrap or binding is absent, show 'Live data is available after publishing'; never substitute the author's data. Explicit snapshot requests remain labeled snapshots. A conversion should re-fetch the required read data and replace embedded copies with widget rendering. Creating or converting a file does not publish it or change sharing permissions.";

/** Post-call guidance only, using the existing runtime usage-note channel. */
export function authoringUsageNotes(policies: Record<string, string>, existing: Record<string, string> = {}): Record<string, string> {
  const notes = { ...existing };
  for (const [name, policy] of Object.entries(policies)) {
    if (policy === "always_allow") notes[name] = [existing[name], AUTHORING_NOTE,
      `The public binding toolName for this call is ${JSON.stringify(name)} (the native name, without the runtime provider__ prefix). Match that exact toolName together with provider; use the discovered binding.id, never an invented id. The render callback must return one DOM Node (a list or DocumentFragment can contain many rows); arrays are invalid, and a returned string is plain text, not HTML.`,
      "Callback contract example: data => { const node = document.createElement('pre'); node.textContent = JSON.stringify(data, null, 2); return node; }. Replace the pre with your detached list/table, but ALWAYS return its root node, including empty-data branches. Do not mutate the widget container inside the callback or return undefined. The helper inserts the returned node and manages connection/error/freshness states.",
    ].filter(Boolean).join("\n");
  }
  return notes;
}
