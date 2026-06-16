# Slash Capability Picker

## Goal

Comparative should give users one simple mental model:

> Type `/`, choose what you want, keep typing, send, and Comparative handles it.

Users should not need to understand whether an option is internally a skill,
tool, app command, workflow, or background job. The slash surface is a
capability picker. The router decides the lightest execution path that can
deliver the request.

## User Contract

- Typing `/` in chat opens one palette of available capabilities.
- Selecting a capability keeps the user in the current chat.
- The composer shows a small active-capability indicator.
- Sending creates a normal user turn in the current thread.
- The transcript shows an indicator such as `/weekly-status`, not the full
  skill prompt.
- The full skill instructions are never pasted into the chat or export.
- A slash selection does not open a new tab or create a new chat unless the
  selected capability explicitly says it will.
- If the selected capability needs a connected tool, the user gets an
  actionable permission or connection message in the same chat flow.

## Capability Types

The palette can contain several internal types while keeping one user-facing
surface.

| Type | User sees | Internal behavior |
| --- | --- | --- |
| Skill | `/weekly-status` | Injects saved skill instructions as hidden context for the turn. |
| Tool shortcut | `/github`, `/search` | Mounts an approved provider or enables a tool lane for the turn. |
| App command | `/feedback`, `/settings` | Opens or controls app UI. |
| Workflow | `/weekly-brief` | Starts a durable or scheduled workflow when the action is explicitly job-shaped. |
| Builder mode | `/app`, `/deck` | Routes to the app/artifact builder lane with the right guardrails. |

Phase 1 ships skills only. The taxonomy is here so future slash options do not
recreate separate UX patterns.

## Phase 1: Slash Skills In Chat

When a user selects or sends a slash skill:

1. The client resolves the selected skill from the palette.
2. The user message is persisted in a compact display form:

   ```text
   /weekly-status summarize the launch work
   ```

3. The UI renders the leading slash token as an active capability pill.
4. `POST /api/chat` receives:

   ```json
   {
     "message": "/weekly-status summarize the launch work",
     "activatedSkills": [
       {
         "id": "skill-id",
         "slug": "weekly-status",
         "source": "explicit",
         "args": "summarize the launch work"
       }
     ]
   }
   ```

5. The server validates that the user can run the skill.
6. If the skill declares required providers, the server validates connection
   and attestation before starting the run.
7. The model-facing prompt receives hidden skill context plus the user's
   request:

   ```xml
   <activated_skill slug="weekly-status" source="user-explicit">
   ...saved skill instructions...
   </activated_skill>

   <user_request>
   summarize the launch work
   </user_request>
   ```

8. The runtime route is upgraded only as needed:
   - no required tools: fast local streaming can stay fast;
   - required tools: local tool lane with approved MCP providers mounted;
   - durable intent: worker lane.

## Non-Goals For Phase 1

- No database migration.
- No persistent multi-turn skill session state.
- No implicit model-selected skills.
- No new production dependencies.
- No changes to the Skills page "Run now" path or scheduled skill execution.

## Follow-On Phases

1. Add non-skill capability entries to the same palette.
2. Add implicit skill activation from the compact skill catalog when the model
   recognizes a matching workflow.
3. Persist structured message metadata for slash pills instead of deriving them
   from the leading token.
4. Add multi-turn active capability state with visible expiry and audit trails.
5. Let selected capabilities request confirmation when they are costly,
   permission-sensitive, or long-running.

## Acceptance Criteria

- `/weekly brief` resolves to the Weekly Status skill and stays in the current
  chat.
- Selecting a skill from the palette does not call `/api/skills/:id/run`.
- The selected skill is sent through `/api/chat` as `activatedSkills`.
- The visible transcript shows a compact slash indicator.
- The assistant receives the saved skill instructions as hidden context.
- The full skill prompt is not visible in chat.
- Tool-dependent skills mount only their declared, approved providers.
- Existing run-now and scheduled skill behavior remains unchanged.
