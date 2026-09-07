/** Public per-binding contract. No credentials or pinned arguments belong here. */
export type AppDataResponse =
  | { state: "ok"; ok: true; data: unknown; fetchedAt: string }
  | {
      state: "needs_connection";
      ok: false;
      needsConnection: true;
      provider: string;
      connectUrl: string;
    }
  | { state: "error"; ok: false; scopedMessage: string };

export const APP_DATA_CONNECT_URL = "/chat?open=settings&section=integrations";

export function appDataError(error: string, scopedMessage: string) {
  return { state: "error" as const, ok: false as const, error, scopedMessage };
}
