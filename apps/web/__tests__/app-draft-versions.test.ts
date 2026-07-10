import { describe, expect, it } from "vitest";
import {
  latestAppDraftVersionIds,
  markAppDraftVersionDeployed,
  parseAppDraftVersionSummaries,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";

function version(
  overrides: Partial<AppDraftVersionSummary> = {},
): AppDraftVersionSummary {
  return {
    id: "version-2",
    appId: "app-1",
    appName: "Revenue Dashboard",
    appSlug: "revenue-dashboard",
    artifactId: "artifact-2",
    versionNumber: 2,
    status: "draft",
    canDeploy: true,
    previewUrl: "/api/apps/app-1/versions/version-2/content",
    liveUrl: "/apps/revenue-dashboard",
    ...overrides,
  };
}

describe("app draft version summaries", () => {
  it("parses complete summaries and drops malformed transport data", () => {
    expect(
      parseAppDraftVersionSummaries([
        version(),
        { ...version({ id: "broken" }), versionNumber: "three" },
        { ...version({ id: "unknown-status" }), status: "pending" },
        null,
      ]),
    ).toEqual([version()]);
  });

  it("keeps only the latest draft affordance for each app", () => {
    const latest = latestAppDraftVersionIds([
      version(),
      version({ id: "version-3", artifactId: "artifact-3", versionNumber: 3 }),
      version({
        id: "other-version-1",
        appId: "app-2",
        appSlug: "other-app",
        versionNumber: 1,
      }),
    ]);

    expect([...latest]).toEqual(["version-3", "other-version-1"]);
  });

  it("marks the selected draft live without discarding history", () => {
    const priorLive = version({
      id: "version-1",
      artifactId: "artifact-1",
      versionNumber: 1,
      status: "deployed",
      canDeploy: false,
    });
    const draft = version();

    expect(
      markAppDraftVersionDeployed(
        [priorLive, draft],
        draft.id,
        "/apps/revenue-dashboard",
      ),
    ).toEqual([
      { ...priorLive, status: "reverted" },
      {
        ...draft,
        status: "deployed",
        canDeploy: false,
        liveUrl: "/apps/revenue-dashboard",
      },
    ]);
  });
});
