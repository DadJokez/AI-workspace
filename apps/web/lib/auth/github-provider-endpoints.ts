import type { GithubEmail, GithubProfile } from "next-auth/providers/github";
import type { OAuthUserConfig } from "next-auth/providers/oauth";
import { GITHUB_DOT_COM } from "@ai-workspace/agent/sources";

type GitHubEndpointOverrides = Pick<
  OAuthUserConfig<GithubProfile>,
  "issuer" | "authorization" | "token" | "userinfo"
>;

/**
 * NextAuth's GitHub provider is written for github.com. For any other host
 * this returns its authorization, token and userinfo endpoints; for
 * github.com it returns nothing, so the provider keeps its own defaults.
 *
 * The userinfo request repeats the provider's own (read the profile, then the
 * primary address when the profile hides it) because the provider's version
 * names api.github.com outright.
 */
export function githubProviderEndpoints(
  webUrl: string,
  apiUrl: string,
): Partial<GitHubEndpointOverrides> {
  if (webUrl === GITHUB_DOT_COM.webUrl && apiUrl === GITHUB_DOT_COM.apiUrl) {
    return {};
  }
  return {
    issuer: `${webUrl}/login/oauth`,
    authorization: `${webUrl}/login/oauth/authorize`,
    token: `${webUrl}/login/oauth/access_token`,
    userinfo: {
      url: `${apiUrl}/user`,
      async request({ client, tokens }) {
        const profile = await client.userinfo(tokens.access_token ?? "");
        if (!profile.email) {
          const res = await fetch(`${apiUrl}/user/emails`, {
            headers: { Authorization: `token ${tokens.access_token}` },
          });
          if (res.ok) {
            const emails = (await res.json()) as GithubEmail[];
            profile.email = (
              emails.find((email) => email.primary) ?? emails[0]
            )?.email;
          }
        }
        return profile;
      },
    },
  };
}
