/**
 * Canonical Settings navigation labels, shared by the Settings UI and the
 * prompt builders that tell the model where the user connects a work tool.
 * One source of truth so model guidance can never drift from the visible UI
 * and invent pages that do not exist (#649). Client-safe: constants only.
 */
export const SETTINGS_INTEGRATIONS_LABEL = "Integrations";

/** Visible path to the Integrations section of Settings. */
export const SETTINGS_INTEGRATIONS_PATH = `Settings → ${SETTINGS_INTEGRATIONS_LABEL}`;

/**
 * Canonical integration card names in the Integrations section, keyed by
 * provider id. The Settings UI renders these same strings, so a rename there
 * updates the model guidance in the same commit.
 */
export const INTEGRATION_DISPLAY_NAMES = {
  github: "GitHub",
  salesforce: "Salesforce",
  notion: "Notion",
  google: "Google Mail & Calendar",
} as const;

/**
 * Visible click path that connects one provider, e.g.
 * "Settings → Integrations → GitHub → Connect GitHub". Unknown provider ids
 * fall back to the section path alone rather than fabricating a card name.
 */
export function integrationConnectPath(providerId: string): string {
  const name =
    INTEGRATION_DISPLAY_NAMES[
      providerId as keyof typeof INTEGRATION_DISPLAY_NAMES
    ];
  return name
    ? `${SETTINGS_INTEGRATIONS_PATH} → ${name} → Connect ${name}`
    : SETTINGS_INTEGRATIONS_PATH;
}
