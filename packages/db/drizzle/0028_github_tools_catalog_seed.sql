WITH github_server AS (
	SELECT "id" FROM "mcp_servers" WHERE "slug" = 'github'
),
seed_tools (
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	"requires_attestation"
) AS (
	VALUES
		('get_me', 'Get current GitHub user', 'Read the authenticated GitHub user profile.', 'context', 'read'::"tool_catalog_action", false),
		('search_repositories', 'Search repositories', 'Search GitHub repositories.', 'repos', 'read'::"tool_catalog_action", true),
		('search_code', 'Search code', 'Search code across accessible repositories.', 'code', 'read'::"tool_catalog_action", true),
		('get_file_contents', 'Get file contents', 'Read file contents from a repository.', 'code', 'read'::"tool_catalog_action", true),
		('list_commits', 'List commits', 'List commits in a repository.', 'repos', 'read'::"tool_catalog_action", true),
		('get_commit', 'Get commit', 'Read a commit and its metadata.', 'repos', 'read'::"tool_catalog_action", true),
		('list_branches', 'List branches', 'List repository branches.', 'repos', 'read'::"tool_catalog_action", true),
		('create_branch', 'Create branch', 'Create a branch in a repository.', 'repos', 'write'::"tool_catalog_action", true),
		('create_or_update_file', 'Create or update file', 'Create or update repository file contents.', 'code', 'write'::"tool_catalog_action", true),
		('push_files', 'Push files', 'Push multiple files to a repository.', 'code', 'write'::"tool_catalog_action", true),
		('delete_file', 'Delete file', 'Delete a file from a repository.', 'code', 'admin'::"tool_catalog_action", true),
		('search_issues', 'Search issues and pull requests', 'Search GitHub issues and pull requests.', 'issues', 'read'::"tool_catalog_action", true),
		('list_issues', 'List issues', 'List issues in a repository.', 'issues', 'read'::"tool_catalog_action", true),
		('get_issue', 'Get issue', 'Read an issue and its metadata.', 'issues', 'read'::"tool_catalog_action", true),
		('create_issue', 'Create issue', 'Create a GitHub issue.', 'issues', 'write'::"tool_catalog_action", true),
		('update_issue', 'Update issue', 'Update GitHub issue fields.', 'issues', 'write'::"tool_catalog_action", true),
		('add_issue_comment', 'Add issue comment', 'Comment on an issue or pull request.', 'issues', 'write'::"tool_catalog_action", true),
		('list_pull_requests', 'List pull requests', 'List pull requests in a repository.', 'pull_requests', 'read'::"tool_catalog_action", true),
		('get_pull_request', 'Get pull request', 'Read pull request metadata.', 'pull_requests', 'read'::"tool_catalog_action", true),
		('get_pull_request_files', 'Get pull request files', 'Read files changed by a pull request.', 'pull_requests', 'read'::"tool_catalog_action", true),
		('get_pull_request_diff', 'Get pull request diff', 'Read a pull request diff.', 'pull_requests', 'read'::"tool_catalog_action", true),
		('get_pull_request_comments', 'Get pull request comments', 'Read pull request review comments.', 'pull_requests', 'read'::"tool_catalog_action", true),
		('create_pull_request', 'Create pull request', 'Create a pull request.', 'pull_requests', 'write'::"tool_catalog_action", true),
		('update_pull_request', 'Update pull request', 'Update pull request fields.', 'pull_requests', 'write'::"tool_catalog_action", true),
		('merge_pull_request', 'Merge pull request', 'Merge a pull request.', 'pull_requests', 'admin'::"tool_catalog_action", true)
)
INSERT INTO "tools_catalog" (
	"mcp_server_id",
	"provider",
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	"requires_attestation",
	"enabled",
	"metadata"
)
SELECT
	(SELECT "id" FROM github_server),
	'github',
	"tool_name",
	"display_name",
	"description",
	"category",
	"action",
	"requires_attestation",
	true,
	jsonb_build_object('seededBy', '0028_github_tools_catalog_seed')
FROM seed_tools
ON CONFLICT ("provider", "tool_name") DO UPDATE SET
	"mcp_server_id" = COALESCE("tools_catalog"."mcp_server_id", EXCLUDED."mcp_server_id"),
	"display_name" = EXCLUDED."display_name",
	"description" = EXCLUDED."description",
	"category" = EXCLUDED."category",
	"action" = EXCLUDED."action",
	"requires_attestation" = EXCLUDED."requires_attestation",
	"metadata" = COALESCE("tools_catalog"."metadata", '{}'::jsonb) || EXCLUDED."metadata",
	"updated_at" = now();
