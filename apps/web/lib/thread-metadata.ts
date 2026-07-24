import {
  chatMessages,
  chatThreads,
  type Database,
} from "@ai-workspace/db";
import { asc, eq } from "drizzle-orm";

type ThreadMessageRole = "user" | "assistant" | "tool";

export interface ThreadMetadataMessage {
  role: ThreadMessageRole;
  content: string;
}

export interface ThreadPresentationMetadata {
  title?: string;
  previewSummary?: string;
}

export function buildThreadPresentationMetadata({
  messages,
  currentTitle,
  titleSource,
}: {
  messages: ThreadMetadataMessage[];
  currentTitle?: string | null;
  titleSource?: string | null;
}): ThreadPresentationMetadata {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => cleanConversationText(message.content))
    .filter(Boolean);
  if (userMessages.length === 0) return {};

  const firstUser = firstSubstantive(userMessages) ?? userMessages[0]!;
  const latestUser =
    latestSubstantive(userMessages) ?? userMessages[userMessages.length - 1]!;
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim());
  const assistantSummary = latestAssistant
    ? summarizeAssistantText(latestAssistant.content)
    : undefined;

  const previewSummary = buildPreviewSummary({
    firstUser,
    latestUser,
    assistantSummary,
  });
  const metadata: ThreadPresentationMetadata = {};
  if (previewSummary) {
    metadata.previewSummary = previewSummary;
  }

  if (titleSource !== "manual") {
    const nextTitle = nextAutomaticThreadTitle({
      currentTitle,
      firstUser,
      latestUser,
    });
    if (nextTitle && nextTitle !== currentTitle?.trim()) {
      metadata.title = nextTitle;
    }
  }

  return metadata;
}

function nextAutomaticThreadTitle({
  currentTitle,
  firstUser,
  latestUser,
}: {
  currentTitle?: string | null;
  firstUser: string;
  latestUser: string;
}): string | undefined {
  const firstTitle = makeThreadTitle(firstUser);
  const latestTitle = makeThreadTitle(latestUser);
  const current = currentTitle?.trim();
  if (!current || isLowSignalTurn(current)) return firstTitle;

  const currentCanonical = makeThreadTitle(current);
  const currentKey = normalizeForCompare(currentCanonical);
  const firstKey = normalizeForCompare(firstTitle);
  const latestKey = normalizeForCompare(latestTitle);

  // Normalize the initial route title once (for example, drop "Can you"),
  // then keep that subject stable as terse follow-ups arrive.
  if (currentKey === firstKey) {
    return current === firstTitle ? undefined : firstTitle;
  }

  // Repair titles written by the former latest-message policy without
  // replacing an independently useful auto title.
  if (firstKey !== latestKey && currentKey === latestKey) {
    return firstTitle;
  }

  return undefined;
}

export async function refreshThreadPresentationMetadata({
  db,
  threadId,
  now = new Date(),
}: {
  db: Database;
  threadId: string;
  now?: Date;
}): Promise<void> {
  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      titleSource: chatThreads.titleSource,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  const thread = rows[0];
  if (!thread) return;

  const messages = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));

  const metadata = buildThreadPresentationMetadata({
    messages,
    currentTitle: thread.title,
    titleSource: thread.titleSource,
  });

  await db
    .update(chatThreads)
    .set({
      updatedAt: now,
      ...(metadata.title ? { title: metadata.title, titleSource: "auto" } : {}),
      previewSummary: metadata.previewSummary ?? null,
      previewSummaryUpdatedAt: metadata.previewSummary ? now : null,
    })
    .where(eq(chatThreads.id, threadId));
}

function buildPreviewSummary({
  firstUser,
  latestUser,
  assistantSummary,
}: {
  firstUser: string;
  latestUser: string;
  assistantSummary?: string;
}): string | undefined {
  const usefulAssistantSummary =
    assistantSummary && !isLowSignalAssistantText(assistantSummary)
      ? assistantSummary
      : undefined;
  if (isLowSignalTurn(latestUser) && !usefulAssistantSummary) {
    return undefined;
  }

  const parts: string[] = [];
  if (normalizeForCompare(firstUser) !== normalizeForCompare(latestUser)) {
    parts.push(`Started: ${shortSentence(firstUser, 90)}.`);
  }
  parts.push(`Asked: ${shortSentence(latestUser, 120)}.`);
  if (usefulAssistantSummary) {
    parts.push(`Answer: ${shortSentence(usefulAssistantSummary, 140)}.`);
  }

  const preview = trimToWords(parts.join(" "), 48);
  return isUsefulPreviewSummary(preview) ? preview : undefined;
}

function makeThreadTitle(text: string): string {
  const withoutLeadIn = text
    .replace(
      /^(can|could|would|will)\s+you\s+/i,
      "",
    )
    .replace(/^(please|pls)\s+/i, "")
    .replace(/^i\s+(need|want|would like)\s+(you\s+to\s+)?/i, "")
    .replace(/^(let's|lets)\s+/i, "")
    .replace(/^we\s+should\s+/i, "")
    .trim();
  const title = shortSentence(withoutLeadIn || text, 60);
  return title ? title[0]!.toUpperCase() + title.slice(1) : title;
}

function firstSubstantive(values: string[]): string | undefined {
  return values.find((value) => !isLowSignalTurn(value));
}

function latestSubstantive(values: string[]): string | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]!;
    if (!isLowSignalTurn(value)) return value;
  }
  return undefined;
}

function isLowSignalTurn(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[.!?]+$/g, "").trim();
  if (normalized.length < 8) return true;
  return (
    /^(hey|hi|hello|yo|ok|okay|cool|thanks|thank you|sounds good|go ahead|do it|merge it|yes|no|nice|great|perfect)$/.test(
      normalized,
    ) ||
    /^(?:(?:quick|one|a)\s+)?question(?:\s+(?:about|on)\s+(?:this|something))?$|^(?:can|could|would)\s+you\s+help(?:\s+me)?(?:\s+with\s+(?:this|something))?$|^i\s+need\s+(?:some\s+)?help$/.test(
      normalized,
    )
  );
}

function isLowSignalAssistantText(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 24) return true;
  return /^(hey|hi|hello|yo|ok|okay|cool|thanks|thank you|sure|sounds good)[\s!,.-]/.test(
    normalized,
  );
}

function isUsefulPreviewSummary(value: string): boolean {
  const normalized = normalizeForCompare(value);
  if (normalized.length < 24) return false;
  return !/^(asked )?(hey|hi|hello|yo|ok|okay|thanks|thank you)$/.test(
    normalized,
  );
}

function summarizeAssistantText(text: string): string {
  const cleaned = cleanConversationText(text)
    .replace(/^assistant\s*[:\-]\s*/i, "")
    .trim();
  return cleaned;
}

function cleanConversationText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, (match) =>
      match.replace(/^\[([^\]]+)]\([^)]*\)$/, "$1"),
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_~\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortSentence(value: string, maxChars: number): string {
  const sentence =
    value.match(/^(.{20,}?[.!?])\s/)?.[1] ??
    value.split(/(?<=[.!?])\s+/)[0] ??
    value;
  const trimmed = sentence.replace(/\s+/g, " ").trim().replace(/[.!?]+$/g, "");
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function trimToWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value;
  return `${words.slice(0, maxWords).join(" ").replace(/[.!?,:;]+$/g, "")}…`;
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
