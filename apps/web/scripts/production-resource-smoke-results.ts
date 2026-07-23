export function partitionResourceToolResults(toolResults: unknown[]) {
  const all = toolResults.filter(
    (result): result is Record<string, unknown> =>
      isRecord(result) &&
      (result.provider === "resources" ||
        (typeof result.name === "string" &&
          result.name.includes("resources"))),
  );

  return {
    all,
    successful: all.filter((result) => result.isError !== true),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
