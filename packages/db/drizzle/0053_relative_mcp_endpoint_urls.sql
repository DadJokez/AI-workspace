-- First-party MCP facade rows were seeded with one deployment's public origin
-- (0032, 0035, 0040). Store the path instead; readers resolve it against the
-- deployment's own base URL. Runtime execution builds these URLs from code, so
-- this column is display/admin data. Idempotent: rewritten rows no longer match.
-- migration-guard-allow: rewrites only the three seeded first-party endpoint URLs to a deployment-relative path
UPDATE "mcp_servers"
SET "endpoint_url" = '/api/mcp/' || "slug", "updated_at" = now()
WHERE "slug" IN ('google', 'salesforce', 'notion')
	AND "endpoint_url" LIKE 'https://comparative.builtwithrobot.link/%';
