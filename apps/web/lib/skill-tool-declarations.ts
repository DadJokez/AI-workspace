export const SKILL_WEB_ACCESS_DECLARATION = "web";

export function skillDeclaresWebAccess(
  declarations: readonly string[] | undefined,
): boolean {
  return declarations?.includes(SKILL_WEB_ACCESS_DECLARATION) ?? false;
}

export function skillMcpProviders(
  declarations: readonly string[] | undefined,
): string[] {
  return (declarations ?? []).filter(
    (provider) => provider !== SKILL_WEB_ACCESS_DECLARATION,
  );
}
