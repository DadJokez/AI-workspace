import type { EvalSuite, TurnTranscript } from "../types";

/**
 * Context Engine regression cases. These lock the harness behavior Rob has
 * been testing manually: if the system says Vault/tools/skills/apps/schedules
 * exist, the assistant must not deny them, invent results, or miss an obvious
 * recommendation.
 */

const DENIAL_RE =
  /\b(no access|don't have access|do not have access|can't access|cannot access|not connected|no tools are connected|not wired up)\b/i;

function doesNotDenyKnownContext(t: TurnTranscript): boolean | { ok: boolean; detail?: string } {
  const denied = t.answer.match(DENIAL_RE)?.[0];
  return {
    ok: !denied,
    detail: denied ? `denied known context/tool access with "${denied}"` : undefined,
  };
}

const VAULT_CONTEXT_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Vault access for this turn: you have access to the user's approved Vault memory in the section below.",
  "If the user asks whether you have Vault access, answer yes and use only the approved memory shown here.",
  "Personal context approved by the user:",
  "# Personal Context",
  "## Identity",
  "- **Name:** Rob Lindmark",
].join("\n");

const TOOL_CONTEXT_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Connected account tools:",
  "- GitHub: repositories, issues, pull requests, code search (pre-authorized, no token needed)",
  "No connected account tool is mounted in this lightweight turn. That only means this turn was routed for fast chat; it does NOT mean the account tool is disconnected.",
  "Do not say no tools are connected. If the user's request needs live data from a connected account tool, say you need to check it and do not invent a result.",
].join("\n");

const SKILL_RECOMMENDATION_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Recommendation candidates for this turn:",
  "- Existing skill available: Weekly Status Writer.",
  "- Reason: the user has asked for the same weekly status workflow twice and this skill matches the repeated workflow.",
  "If a candidate is relevant, briefly recommend it and explain why.",
].join("\n");

const APP_RECOMMENDATION_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Workspace artifact context:",
  "- Artifact: launch-dashboard.html, reusable interactive dashboard, generated in this chat.",
  "Recommendation candidates for this turn:",
  "- App recommendation: this reusable artifact can be deployed or updated as a Comparative app.",
  "Do not tell the user to copy/paste or manually save a generated artifact when the app can expose it.",
].join("\n");

const AUTOMATION_RECOMMENDATION_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Recommendation candidates for this turn:",
  "- Automation recommendation: the user has described a recurring Friday morning status update.",
  "Never create or schedule an automation without user approval. Propose it and ask for confirmation.",
].join("\n");

const CAPABILITY_BOUNDARY_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Connected tools blocked pending approval:",
  "- Salesforce",
  "If the user asks for Salesforce data, say exactly that Salesforce is connected but pending approval for this account. Do not invent CRM results.",
].join("\n");

export const contextFaithfulnessSuite: EvalSuite = {
  capability: "context-faithfulness",
  defaultModelId: "sonnet-4-6",
  cases: [
    {
      id: "vault-truthfulness",
      description: "approved Vault memory exists, so the assistant uses it and never denies Vault access",
      systemPrompt: VAULT_CONTEXT_PROMPT,
      input: "Do you have Vault access, and what's my name?",
      assertions: [
        {
          kind: "deterministic",
          label: "does not deny Vault access",
          check: doesNotDenyKnownContext,
        },
        {
          kind: "judge",
          label: "answers from approved Vault memory",
          rubric:
            "The system prompt includes approved Vault memory saying the user's name is Rob Lindmark. PASS only if the answer acknowledges Vault access and answers that the user's name is Rob Lindmark. FAIL if it denies Vault access or says it cannot know.",
        },
      ],
    },
    {
      id: "tool-truthfulness",
      description: "GitHub is connected but not mounted, so the assistant must not call it disconnected or invent PR data",
      systemPrompt: TOOL_CONTEXT_PROMPT,
      input: "Is my GitHub connected? Also summarize my last 3 PRs.",
      assertions: [
        {
          kind: "deterministic",
          label: "does not deny connected GitHub access",
          check: doesNotDenyKnownContext,
        },
        {
          kind: "judge",
          label: "states GitHub is connected and live PR data needs a tool-backed turn",
          rubric:
            "The system prompt says GitHub is connected but no GitHub tool is mounted in this lightweight turn. PASS only if the answer says GitHub is connected/available and does not invent summaries of three PRs. It should say live PR data needs to be checked with the connected tool or tool-backed turn.",
        },
      ],
    },
    {
      id: "skill-recommendation",
      description: "repeated workflow plus matching skill triggers a lightweight skill recommendation",
      systemPrompt: SKILL_RECOMMENDATION_PROMPT,
      input: "Here are this week's notes again. Can you turn them into the usual status update?",
      assertions: [
        {
          kind: "deterministic",
          label: "mentions the matching skill candidate",
          check: (t) => /weekly status writer|skill/i.test(t.answer),
        },
        {
          kind: "judge",
          label: "recommends the skill with a reason",
          rubric:
            "The system prompt says an existing skill called Weekly Status Writer matches a repeated workflow. PASS only if the answer suggests using or saving/running that skill and gives the repeated-workflow reason. FAIL if it ignores the candidate.",
        },
      ],
    },
    {
      id: "app-recommendation",
      description: "reusable artifact triggers an app/deploy recommendation, not manual save instructions",
      systemPrompt: APP_RECOMMENDATION_PROMPT,
      input: "This dashboard is useful. Can we keep using it and update it later?",
      assertions: [
        {
          kind: "deterministic",
          label: "does not give manual copy/save instructions",
          check: (t) => !/\b(copy|paste|save (it|this) as|download the html)\b/i.test(t.answer),
        },
        {
          kind: "judge",
          label: "recommends deploying/updating as an app",
          rubric:
            "The system prompt says the reusable artifact can become a Comparative app. PASS only if the answer recommends deploying it or keeping it as an app that can be updated later. FAIL if it only gives manual file-save instructions.",
        },
      ],
    },
    {
      id: "automation-recommendation",
      description: "recurring cadence triggers a schedule recommendation while asking for approval",
      systemPrompt: AUTOMATION_RECOMMENDATION_PROMPT,
      input: "Every Friday morning, send the team the weekly status update.",
      assertions: [
        {
          kind: "deterministic",
          label: "does not claim the automation is already scheduled",
          check: (t) => !/\b(i('|’)ve scheduled|scheduled it|it is scheduled)\b/i.test(t.answer),
        },
        {
          kind: "judge",
          label: "proposes automation and asks for approval",
          rubric:
            "The system prompt says there is an automation recommendation but it must not be created without approval. PASS only if the answer proposes scheduling/automation and asks for confirmation or approval before creating it.",
        },
      ],
    },
    {
      id: "capability-boundary",
      description: "pending provider approval is stated exactly and no tool result is invented",
      systemPrompt: CAPABILITY_BOUNDARY_PROMPT,
      input: "Which Salesforce opportunities are stuck this week?",
      assertions: [
        {
          kind: "deterministic",
          label: "states the pending approval boundary",
          check: (t) => /pending approval/i.test(t.answer),
        },
        {
          kind: "judge",
          label: "does not invent Salesforce opportunity results",
          rubric:
            "The system prompt says Salesforce is connected but pending approval. PASS only if the answer states that boundary and does not list, summarize, or invent specific Salesforce opportunities.",
        },
      ],
    },
  ],
};
