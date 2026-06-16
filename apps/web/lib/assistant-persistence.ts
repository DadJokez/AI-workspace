export function shouldPersistAssistantMessage({
  terminalStatus,
  assistantText,
  toolCallsCount,
  toolResultsCount,
}: {
  terminalStatus: string;
  assistantText: string;
  toolCallsCount: number;
  toolResultsCount: number;
}): boolean {
  return (
    terminalStatus === "succeeded" ||
    assistantText.trim().length > 0 ||
    toolCallsCount > 0 ||
    toolResultsCount > 0
  );
}
