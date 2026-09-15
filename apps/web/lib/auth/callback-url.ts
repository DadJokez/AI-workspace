/** Keep login destinations local after the browser's URL normalization. */
export function sanitizeCallbackUrl(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  // Backslashes become slashes; URL parsers silently discard some controls.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  const origin = "https://callback.invalid";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Dot-segment normalization must not produce a protocol-relative path.
    return path.startsWith("//") ? null : path;
  } catch {
    return null;
  }
}
