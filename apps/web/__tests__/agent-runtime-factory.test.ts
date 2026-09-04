import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@ai-workspace/agent";
import {
  BUILT_IN_RUNTIME_NAMES,
  getRuntime,
  registerRuntime,
  type AgentRuntime,
} from "@ai-workspace/agent-runtime";

/**
 * #797 P1: the runtime set is open. A third adapter registers by name and is
 * selectable via the same `getRuntime` seam the chat routes use — no edit to
 * `RuntimeName`, the factory, or the SSE relay.
 */
function fakeRuntime(name: string): AgentRuntime {
  return {
    name,
    capabilities: { liveTurnSteering: false },
    async *runTurn() {
      yield* [] as AgentEvent[];
    },
  };
}

describe("agent-runtime factory registration", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllEnvs();
  });

  it("selects a registered adapter by per-run override and by RUNTIME", () => {
    cleanups.push(registerRuntime("acme", () => fakeRuntime("acme")));

    expect(getRuntime({ runtime: "acme" }).name).toBe("acme");
    vi.stubEnv("RUNTIME", "ACME");
    expect(getRuntime().name).toBe("acme");
  });

  it("keeps rejecting unknown names, listing built-ins and registrations", () => {
    cleanups.push(registerRuntime("acme", () => fakeRuntime("acme")));

    expect(() => getRuntime({ runtime: "nope" })).toThrow(
      `Unknown runtime='nope'. Expected one of: ${[...BUILT_IN_RUNTIME_NAMES, "acme"].join(", ")}.`,
    );
  });

  it("reserves built-in names and refuses duplicate registrations", () => {
    expect(() => registerRuntime("bedrock", () => fakeRuntime("bedrock"))).toThrow(
      "built in",
    );
    cleanups.push(registerRuntime("acme", () => fakeRuntime("acme")));
    expect(() => registerRuntime("acme", () => fakeRuntime("acme"))).toThrow(
      "already registered",
    );
  });

  it("refuses an adapter whose reported name differs from its registration", () => {
    cleanups.push(registerRuntime("acme", () => fakeRuntime("other")));

    expect(() => getRuntime({ runtime: "acme" })).toThrow(
      "Runtime registered as 'acme' reports name 'other'.",
    );
  });

  it("unregisters cleanly", () => {
    const unregister = registerRuntime("acme", () => fakeRuntime("acme"));
    unregister();

    expect(() => getRuntime({ runtime: "acme" })).toThrow("Unknown runtime='acme'");
  });
});
