import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/scripts/deploy-retrigger.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const dirs: string[] = [];
const sha = "a".repeat(40);
const other = "b".repeat(40);
const build = (status = "IN_PROGRESS", source = sha, number = 1) => ({
  id: `ai-workspace-build:${number}`, projectName: "ai-workspace-build", buildNumber: number,
  sourceVersion: source, buildStatus: status,
});
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp() { const dir = mkdtempSync(join(tmpdir(), "deploy-retrigger-")); dirs.push(dir); return dir; }
function evaluate(code: string) {
  const result = spawnSync("node", ["--input-type=module", "-e",
    `import { decideBuild, retrigger } from ${JSON.stringify(script)};\n${code}`], { encoding: "utf8" });
  return result;
}

describe("deployment retrigger", () => {
  it.each(["valid", "missing receipt", "wrong limit", "api failure", "duplicate receipt"])("checks the AWS inventory end-to-end: %s", (scenario) => {
    const bin = temp();
    writeFileSync(join(bin, "aws"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
if (scenario === 'api failure') process.exit(1);
if (args[1] === 'batch-get-projects') {
  if (!args.includes('--query')) process.exit(2);
  console.log(JSON.stringify({projects:[{name:'ai-workspace-build',concurrentBuildLimit:scenario === 'wrong limit' ? 2 : 1}]}));
} else if (args[1] === 'list-builds-for-project') {
  if (args.includes('--no-paginate') || args.includes('--sort-order')) process.exit(2);
  console.log(JSON.stringify({ids:['ai-workspace-build:1','ai-workspace-build:2']}));
} else if (args[1] === 'batch-get-builds') {
  if (!args.includes('--query') || !args.includes('--ids')) process.exit(2);
  console.log(JSON.stringify({builds: scenario === 'missing receipt' ? [] : [${JSON.stringify(build())}, scenario === 'duplicate receipt' ? ${JSON.stringify(build())} : ${JSON.stringify(build("SUCCEEDED", other, 2))}]}));
} else process.exit(2);
`, { mode: 0o755 });
    const result = spawnSync("node", ["--input-type=module", "-e",
      `import { buildsForProject } from ${JSON.stringify(script)}; console.log(JSON.stringify(buildsForProject()));`],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    if (scenario === "valid") {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(2);
    } else expect(result.status).not.toBe(0);
  });
  it.each(["IN_PROGRESS", "SUCCEEDED"])("observes a matching %s run without duplicating it", (status) => {
    const result = evaluate(`console.log(JSON.stringify(decideBuild(${JSON.stringify([build(status)])}, '${sha}')))`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe("observed");
  });
  it.each(["FAILED", "FAULT", "STOPPED", "TIMED_OUT"])("does not auto-retry a known %s run", (status) => {
    expect(evaluate(`decideBuild(${JSON.stringify([build(status)])}, '${sha}')`).status).not.toBe(0);
  });
  it("uses resolved source rather than a misleading source ref", () => {
    const row = { ...build(), resolvedSourceVersion: other };
    const result = evaluate(`console.log(JSON.stringify(decideBuild(${JSON.stringify([row])}, '${sha}')))`);
    expect(JSON.parse(result.stdout).action).toBe("wait");
  });
  it("honors a newer deliberate retry of a failed run", () => {
    const result = evaluate(`console.log(JSON.stringify(decideBuild(${JSON.stringify([build("IN_PROGRESS", sha, 2), build("FAILED")])}, '${sha}')))`);
    expect(JSON.parse(result.stdout).buildId).toBe("ai-workspace-build:2");
  });
  it("waits for the webhook grace period and busy project before starting once", () => {
    const path = join(temp(), "receipt.json");
    const result = evaluate(`
      let reads = 0, starts = 0; const waits = [];
      await retrigger('${sha}', ${JSON.stringify(path)}, {
        readBuilds: () => reads++ === 0 ? [${JSON.stringify(build("IN_PROGRESS", other))}] : [],
        start: () => { starts++; return { build: ${JSON.stringify(build())} }; },
        sleep: async ms => { waits.push(ms); }, now: () => 0,
      });
      if (starts !== 1 || JSON.stringify(waits) !== '[120000,30000]') throw Error('bad orchestration');
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ sha, action: "start", buildId: "ai-workspace-build:1" });
  });
  it.each(["ambiguous start failure", "wrong source", "inventory failure", "busy timeout"])("fails visibly on %s", (scenario) => {
    const path = join(temp(), "receipt.json");
    const result = evaluate(`
      let ticks = 0;
      await retrigger('${sha}', ${JSON.stringify(path)}, {
        readBuilds: () => { ${scenario === "inventory failure" ? "throw Error('inventory unavailable');" : `return ${scenario === "busy timeout" ? JSON.stringify([build("IN_PROGRESS", other)]) : "[]"};`} },
        start: () => { ${scenario === "ambiguous start failure" ? "throw Error('uncertain result');" : `return {build: ${JSON.stringify(build("IN_PROGRESS", other))}};`} },
        sleep: async () => {}, now: () => ${scenario === "busy timeout" ? "ticks++ * 3_000_000" : "0"},
      });
    `);
    expect(result.status).not.toBe(0);
  });
  it("fails closed on malformed receipts and SHAs", () => {
    expect(evaluate(`decideBuild([{}], '${sha}')`).status).not.toBe(0);
    expect(evaluate("decideBuild([], 'main')").status).not.toBe(0);
  });
  it("has main-only pinned workflow, isolated receipt permissions and guards before writes", () => {
    const workflow = readFileSync(join(root, ".github/workflows/deploy-retrigger.yml"), "utf8");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toContain("pull_request");
    expect(workflow).toContain("group: deploy-retrigger-${{ github.sha }}");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow.match(/uses: [^\n]+@[a-f0-9]{40}/g)).toHaveLength(4);
    const buildspec = readFileSync(join(root, "buildspec.yml"), "utf8");
    expect(buildspec.indexOf("deploy-retrigger.mjs guard")).toBeLessThan(buildspec.indexOf("classify-production-deploy.sh"));
    expect(buildspec.lastIndexOf("deploy-retrigger.mjs guard")).toBeLessThan(buildspec.indexOf("docker push"));
    expect(buildspec).toContain('CODEBUILD_BUILD_SUCCEEDING:-0');
  });
});

describe("deployment ancestry guard with real git", () => {
  function fixture() {
    const dir = temp();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    writeFileSync(join(dir, "source"), "before"); git("add", "."); git("commit", "-m", "before"); const before = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "source"), "after"); git("add", "."); git("commit", "-m", "after"); const after = git("rev-parse", "HEAD");
    git("remote", "add", "origin", dir);
    const bin = temp();
    writeFileSync(join(bin, "aws"), `#!/usr/bin/env node
const stack = process.argv[process.argv.indexOf('--stack-name') + 1];
console.log(JSON.stringify({status: process.env.FAKE_STATUS || 'UPDATE_COMPLETE', tag: stack === 'AiWorkspaceEcsStack' ? process.env.FAKE_ECS : process.env.FAKE_AGENT}));
`, { mode: 0o755 });
    const run = (ecs: string, agent = ecs, status = "UPDATE_COMPLETE") => spawnSync("node", [script, "guard", git("rev-parse", "HEAD"), join(dir, "baseline.env")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_ECS: ecs, FAKE_AGENT: agent, FAKE_STATUS: status },
    });
    return { dir, git, before, after, run };
  }
  it("accepts a descendant and classifies from the older component after a partial deployment", () => {
    const f = fixture(); const result = f.run(f.after, f.before);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.dir, "baseline.env"), "utf8")).toBe(`export DEPLOYED_COMMIT=${f.before}\n`);
  });
  it("refuses a stale build instead of rolling back production", () => {
    const f = fixture(); f.git("checkout", "--detach", f.before);
    expect(f.run(f.after).status).not.toBe(0);
  });
  it("refuses unverifiable or still-updating stack state", () => {
    const f = fixture();
    expect(f.run("latest").status).not.toBe(0);
    expect(f.run(f.before, f.before, "UPDATE_IN_PROGRESS").status).not.toBe(0);
  });
});
