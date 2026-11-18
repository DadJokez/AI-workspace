/**
 * GitHub Actions sets GITHUB_API_URL on every runner. It names the same thing
 * as this app's own setting, so on a GitHub Enterprise runner it would
 * configure the code under test. Tests choose these values themselves.
 */
for (const name of ["GITHUB_WEB_URL", "GITHUB_API_URL", "GITHUB_MCP_URL"]) {
  delete process.env[name];
}
