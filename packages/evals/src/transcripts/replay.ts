import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GoldenTranscriptConfig {
  id: string;
  description: string;
  expect: {
    availableCapabilities?: string[];
    modelClaimsMatchLabels?: boolean;
    describedFilesHaveArtifacts?: boolean;
    attachmentMentionsHaveEvidence?: boolean;
    noManualSaveInstructionsAfterArtifacts?: boolean;
  };
}

export interface ParsedTranscript {
  title: string;
  messages: ParsedTranscriptMessage[];
  artifacts: string[];
  attachments: string[];
  activityReceipts: string[];
}

export interface ParsedTranscriptMessage {
  index: number;
  role: "user" | "assistant" | "tool";
  modelLabel?: string;
  content: string;
  artifacts: string[];
  attachments: string[];
  activityReceipts: string[];
}

export interface ReplayAssertionResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface ReplayResult {
  id: string;
  description: string;
  sourcePath: string;
  passed: boolean;
  assertions: ReplayAssertionResult[];
  parsed: {
    userTurns: number;
    assistantTurns: number;
    artifacts: string[];
    attachments: string[];
    activityReceipts: string[];
    modelLabels: string[];
  };
}

const CONFIG_RE = /<!--\s*golden-transcript\s*([\s\S]*?)-->/m;
const MESSAGE_HEADING_RE =
  /^##\s+(\d+)\.\s+(User|Assistant|Tool)(?:\s+-\s+(.+))?\s*$/gim;
const SUBHEADING_RE = /^###\s+(.+?)\s*$/gim;
const STRUCTURAL_SECTION_NAMES = new Set(["Artifacts", "Attachments", "Activity"]);
const ARTIFACT_LINE_RE = /^-\s+(.+?)\s+\([^)]+\)\s+-\s+.+$/gm;
const LIST_LINE_RE = /^-\s+(.+)$/gm;
const FILE_RE =
  /`([^`\n]+\.(?:md|markdown|html|jsx|tsx|js|ts|css|json|csv|xlsx|docx|pptx|pdf|txt))`|\b([A-Za-z0-9][\w.-]+\.(?:md|markdown|html|jsx|tsx|js|ts|css|json|csv|xlsx|docx|pptx|pdf|txt))\b/gi;
const MANUAL_SAVE_RE =
  /\b(copy (all )?(the )?code|paste (it|the code)|save (it|this|the file) as|open notepad|open textedit|double-?click the file|manual save)\b/i;
const ATTACHMENT_MENTION_RE =
  /\b(attached|attachment|uploaded|upload|screenshot|screenshots|image|images|file|files|document|spreadsheet|deck|pdf)\b/i;
const IMAGE_ATTACHMENT_MENTION_RE = /\b(screenshot|screenshots|image|images)\b/i;
const GENERATED_FILE_TRIGGER_RE =
  /\b(written to|wrote|created|generated|saved|file is|artifact is|here is|here's|attached is)\b/i;

const CAPABILITY_DENIALS: Record<string, RegExp> = {
  vault:
    /\b(no vault access|don't have (access to )?(your )?vault|do not have (access to )?(your )?vault|can't access (your )?vault|cannot access (your )?vault|not able to reach (your )?vault|unable to reach (your )?vault)\b/i,
  github:
    /\b(github (is )?(not connected|disconnected)|don't have (access to )?github|do not have (access to )?github|can't access github|cannot access github|not able to reach github|unable to reach github|no tools are connected|not connected to github)\b/i,
  tools:
    /\b(no tools are connected|don't have access to tools|do not have access to tools|can't access tools|cannot access tools)\b/i,
};

export function parseGoldenTranscriptConfig(
  markdown: string,
  sourcePath = "(inline)",
): GoldenTranscriptConfig {
  const match = markdown.match(CONFIG_RE);
  if (!match) {
    throw new Error(`${sourcePath}: missing <!-- golden-transcript {json} --> block`);
  }
  try {
    const parsed = JSON.parse(match[1]!.trim()) as GoldenTranscriptConfig;
    if (!parsed.id || !parsed.description || !parsed.expect) {
      throw new Error("config requires id, description, and expect");
    }
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${sourcePath}: invalid golden transcript config: ${detail}`);
  }
}

export function parseTranscriptMarkdown(markdown: string): ParsedTranscript {
  const body = markdown.replace(CONFIG_RE, "").trim();
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Chat transcript";
  const messages = parseMessages(body);
  const artifacts = unique(messages.flatMap((message) => message.artifacts));
  const attachments = unique(messages.flatMap((message) => message.attachments));
  const activityReceipts = unique(
    messages.flatMap((message) => message.activityReceipts),
  );
  return { title, messages, artifacts, attachments, activityReceipts };
}

export function replayGoldenTranscript(
  markdown: string,
  sourcePath = "(inline)",
): ReplayResult {
  const config = parseGoldenTranscriptConfig(markdown, sourcePath);
  const transcript = parseTranscriptMarkdown(markdown);
  const assertions = evaluateTranscript(config, transcript);
  return {
    id: config.id,
    description: config.description,
    sourcePath,
    passed: assertions.every((assertion) => assertion.ok),
    assertions,
    parsed: {
      userTurns: transcript.messages.filter((m) => m.role === "user").length,
      assistantTurns: transcript.messages.filter((m) => m.role === "assistant")
        .length,
      artifacts: transcript.artifacts,
      attachments: transcript.attachments,
      activityReceipts: transcript.activityReceipts,
      modelLabels: unique(
        transcript.messages
          .map((message) => message.modelLabel)
          .filter((label): label is string => Boolean(label)),
      ),
    },
  };
}

export function replayGoldenTranscriptFiles(paths: string[]): ReplayResult[] {
  return paths.map((path) =>
    replayGoldenTranscript(readFileSync(path, "utf8"), path),
  );
}

export function findGoldenTranscriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...findGoldenTranscriptFiles(path));
    } else if (entry.endsWith(".md") && entry.toLowerCase() !== "readme.md") {
      out.push(path);
    }
  }
  return out.sort();
}

function parseMessages(markdown: string): ParsedTranscriptMessage[] {
  const headings = Array.from(markdown.matchAll(MESSAGE_HEADING_RE));
  const messages: ParsedTranscriptMessage[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    const next = headings[i + 1];
    const rawRole = heading[2]!.toLowerCase();
    const role = rawRole as ParsedTranscriptMessage["role"];
    const block = markdown.slice(
      (heading.index ?? 0) + heading[0].length,
      next?.index ?? markdown.length,
    );
    const sections = splitSections(block);
    messages.push({
      index: Number(heading[1]),
      role,
      modelLabel: heading[3]?.trim(),
      content: sections.content.trim(),
      artifacts: parseArtifactNames(sections.sections.get("Artifacts") ?? ""),
      attachments: parseListSection(sections.sections.get("Attachments") ?? ""),
      activityReceipts: parseListSection(sections.sections.get("Activity") ?? ""),
    });
  }
  return messages;
}

function splitSections(block: string): {
  content: string;
  sections: Map<string, string>;
} {
  const matches = Array.from(block.matchAll(SUBHEADING_RE)).filter((match) =>
    STRUCTURAL_SECTION_NAMES.has(match[1]!.trim()),
  );
  if (matches.length === 0) return { content: cleanupContent(block), sections: new Map() };

  const sections = new Map<string, string>();
  const content = block.slice(0, matches[0]!.index).trim();
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const next = matches[i + 1];
    const name = match[1]!.trim();
    sections.set(
      name,
      block.slice((match.index ?? 0) + match[0].length, next?.index ?? block.length),
    );
  }
  return { content: cleanupContent(content), sections };
}

function cleanupContent(value: string): string {
  return value
    .replace(/^---\s*/gm, "")
    .replace(/^Status:\s+.*$/gm, "")
    .trim();
}

function parseArtifactNames(section: string): string[] {
  const names: string[] = [];
  for (const match of section.matchAll(ARTIFACT_LINE_RE)) {
    names.push(match[1]!.trim());
  }
  return unique(names);
}

function parseListSection(section: string): string[] {
  const values: string[] = [];
  for (const match of section.matchAll(LIST_LINE_RE)) {
    values.push(match[1]!.trim());
  }
  return unique(values);
}

function evaluateTranscript(
  config: GoldenTranscriptConfig,
  transcript: ParsedTranscript,
): ReplayAssertionResult[] {
  const assertions: ReplayAssertionResult[] = [];
  const expect = config.expect;

  if (expect.availableCapabilities?.length) {
    for (const capability of expect.availableCapabilities) {
      assertions.push(assertCapabilityNotDenied(transcript, capability));
    }
  }
  if (expect.modelClaimsMatchLabels) {
    assertions.push(assertModelClaimsMatchLabels(transcript));
  }
  if (expect.describedFilesHaveArtifacts) {
    assertions.push(assertDescribedFilesHaveArtifacts(transcript));
  }
  if (expect.attachmentMentionsHaveEvidence) {
    assertions.push(assertAttachmentMentionsHaveEvidence(transcript));
  }
  if (expect.noManualSaveInstructionsAfterArtifacts) {
    assertions.push(assertNoManualSaveInstructionsAfterArtifacts(transcript));
  }

  return assertions.length
    ? assertions
    : [
        {
          ok: false,
          label: "has at least one expectation",
          detail: "golden transcript config did not enable any assertions",
        },
      ];
}

function assertCapabilityNotDenied(
  transcript: ParsedTranscript,
  capability: string,
): ReplayAssertionResult {
  const normalized = capability.toLowerCase();
  const re = CAPABILITY_DENIALS[normalized] ?? capabilityDenialRegex(normalized);
  const denial = transcript.messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({ message, match: message.content.match(re)?.[0] }))
    .find((item) => item.match);
  return {
    ok: !denial,
    label: `does not deny available ${capability}`,
    detail: denial
      ? `assistant message ${denial.message.index} denied ${capability} with "${denial.match}"`
      : undefined,
  };
}

function assertModelClaimsMatchLabels(
  transcript: ParsedTranscript,
): ReplayAssertionResult {
  const mismatch = transcript.messages
    .filter((message) => message.role === "assistant" && message.modelLabel)
    .map((message) => ({
      message,
      labelFamily: modelFamily(message.modelLabel ?? ""),
      claimFamilies: modelClaimFamilies(message.content),
    }))
    .find(
      ({ labelFamily, claimFamilies }) =>
        labelFamily && claimFamilies.some((claim) => claim !== labelFamily),
    );
  return {
    ok: !mismatch,
    label: "assistant model claims match transcript labels",
    detail: mismatch
      ? `assistant message ${mismatch.message.index} label "${mismatch.message.modelLabel}" conflicts with claim(s): ${mismatch.claimFamilies.join(", ")}`
      : undefined,
  };
}

function assertDescribedFilesHaveArtifacts(
  transcript: ParsedTranscript,
): ReplayAssertionResult {
  const artifactNames = new Set(transcript.artifacts.map((name) => name.toLowerCase()));
  const attachmentNames = filenameKeys(transcript.attachments);
  const missing: string[] = [];
  for (const message of transcript.messages.filter((m) => m.role === "assistant")) {
    for (const filename of extractDescribedFilenames(
      message.content,
      attachmentNames,
    )) {
      if (!artifactNames.has(filename.toLowerCase())) {
        missing.push(`message ${message.index}: ${filename}`);
      }
    }
  }
  return {
    ok: missing.length === 0,
    label: "described generated files have artifact references",
    detail: missing.length ? `missing artifact(s): ${missing.join("; ")}` : undefined,
  };
}

function assertAttachmentMentionsHaveEvidence(
  transcript: ParsedTranscript,
): ReplayAssertionResult {
  const missingEvidence = transcript.messages
    .filter((message) => message.role === "assistant")
    .filter((message) => ATTACHMENT_MENTION_RE.test(message.content))
    .filter((message) => {
      const imageMention = IMAGE_ATTACHMENT_MENTION_RE.test(message.content);
      const hasEvidence = imageMention
        ? transcript.attachments.length > 0
        : transcript.attachments.length > 0 || transcript.artifacts.length > 0;
      return !hasEvidence;
    });
  return {
    ok: missingEvidence.length === 0,
    label: "attachment mentions have attachment or artifact evidence",
    detail: missingEvidence.length
      ? `assistant message(s) ${missingEvidence
          .map((message) => message.index)
          .join(", ")} mention uploads/files without matching evidence`
      : undefined,
  };
}

function assertNoManualSaveInstructionsAfterArtifacts(
  transcript: ParsedTranscript,
): ReplayAssertionResult {
  const offending = transcript.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.artifacts.length > 0 &&
      MANUAL_SAVE_RE.test(message.content),
  );
  return {
    ok: !offending,
    label: "artifact messages do not include manual copy/save instructions",
    detail: offending
      ? `assistant message ${offending.index} has artifact(s) and manual save instructions`
      : undefined,
  };
}

function extractDescribedFilenames(
  content: string,
  ignoredFilenames = new Set<string>(),
): string[] {
  const filenames: string[] = [];
  for (const clause of generatedFileClauses(content)) {
    if (!GENERATED_FILE_TRIGGER_RE.test(clause)) continue;
    for (const match of clause.matchAll(FILE_RE)) {
      const filename = (match[1] ?? match[2] ?? "").trim();
      if (!filename || ignoredFilenames.has(filename.toLowerCase())) continue;
      filenames.push(filename);
    }
  }
  return unique(filenames.filter(Boolean));
}

function generatedFileClauses(content: string): string[] {
  return content
    .split(
      /(?<=[.!?;])\s+|\n+|,\s+(?=(?:and|then|also)\s+(?:written to|wrote|created|generated|saved|file is|artifact is|here is|here's|attached is)\b)|\s+(?=(?:and|then|also)\s+(?:written to|wrote|created|generated|saved|file is|artifact is|here is|here's|attached is)\b)/i,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function modelFamily(value: string): "haiku" | "sonnet" | "opus" | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  return null;
}

function modelClaimFamilies(content: string): Array<"haiku" | "sonnet" | "opus"> {
  const claims = new Set<"haiku" | "sonnet" | "opus">();
  const identityClaimRe =
    /\b(?:i am|i'm|i’m|i am running as|i'm running as|i’m running as|this is|you are talking to|you're talking to|you’re talking to|you are using|you're using|you’re using|you are currently on|you're currently on|you’re currently on|the model is)\s+(?:claude\s+)?(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\s+){0,4}?(haiku|sonnet|opus)\b/gi;
  for (const match of content.matchAll(identityClaimRe)) {
    claims.add(match[1]!.toLowerCase() as "haiku" | "sonnet" | "opus");
  }
  return Array.from(claims);
}

function filenameKeys(values: string[]): Set<string> {
  const keys = new Set<string>();
  for (const value of values) {
    for (const filename of extractFilenames(value)) {
      keys.add(filename.toLowerCase());
    }
  }
  return keys;
}

function extractFilenames(content: string): string[] {
  const filenames: string[] = [];
  for (const match of content.matchAll(FILE_RE)) {
    filenames.push((match[1] ?? match[2] ?? "").trim());
  }
  return unique(filenames.filter(Boolean));
}

function capabilityDenialRegex(capability: string): RegExp {
  return new RegExp(
    `\\b(no ${escapeRegExp(capability)} access|${escapeRegExp(
      capability,
    )} (is )?(not connected|disconnected)|don't have access to ${escapeRegExp(
      capability,
    )}|do not have access to ${escapeRegExp(
      capability,
    )}|can't access ${escapeRegExp(capability)}|cannot access ${escapeRegExp(
      capability,
    )})\\b`,
    "i",
  );
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultTranscriptRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../golden-transcripts");
}

function main() {
  const args = process.argv.slice(2);
  const paths = args.length
    ? args.flatMap((arg) => {
        const path = resolve(arg);
        if (statSync(path).isDirectory()) return findGoldenTranscriptFiles(path);
        return [path];
      })
    : findGoldenTranscriptFiles(defaultTranscriptRoot());

  if (paths.length === 0) {
    console.error("No golden transcript fixtures found.");
    process.exit(2);
  }

  const results = replayGoldenTranscriptFiles(paths);
  let failed = 0;
  for (const result of results) {
    if (!result.passed) failed += 1;
    const icon = result.passed ? "✅" : "❌";
    console.log(`${icon} ${result.id} — ${result.description}`);
    console.log(
      `   parsed ${result.parsed.userTurns} user / ${result.parsed.assistantTurns} assistant turns · artifacts: ${result.parsed.artifacts.length} · activity: ${result.parsed.activityReceipts.length}`,
    );
    for (const assertion of result.assertions.filter((a) => !a.ok)) {
      console.log(`   ✗ ${assertion.label}${assertion.detail ? ` — ${assertion.detail}` : ""}`);
    }
  }

  console.log(
    `\n${failed === 0 ? "✅" : "❌"} ${results.length - failed} passed, ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
