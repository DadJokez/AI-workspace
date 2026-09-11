import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROJECT = "ai-workspace-build";
const SHA = /^[a-f0-9]{40}$/;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]);
const BUILD_FIELDS = "{id:id,projectName:projectName,buildNumber:buildNumber,sourceVersion:sourceVersion,resolvedSourceVersion:resolvedSourceVersion,buildStatus:buildStatus}";

function command(binary, args) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // AWS responses can contain configuration; never dump raw CLI output.
    throw new Error(`${binary} ${args[0]} failed; inspect the service separately`);
  }
}

function aws(...args) {
  return JSON.parse(command("aws", [
    ...args, "--region", "us-east-1", "--output", "json", "--no-cli-pager",
  ]));
}

export function decideBuild(builds, sha) {
  if (!SHA.test(sha)) throw new Error("Expected a full lowercase commit SHA");
  for (const build of builds) {
    if (build?.projectName !== PROJECT || typeof build.id !== "string" ||
        !Number.isSafeInteger(build.buildNumber) || build.buildNumber < 1 ||
        !["IN_PROGRESS", ...TERMINAL].includes(build.buildStatus)) {
      throw new Error("Incomplete or unexpected build receipt");
    }
  }
  const matches = builds.filter((build) =>
    (build.resolvedSourceVersion || build.sourceVersion) === sha);
  // A manual retry may supersede an earlier failure. Prefer the newest run.
  matches.sort((a, b) => Number(b.buildNumber) - Number(a.buildNumber));
  if (matches.length) {
    const build = matches[0];
    if (build.buildStatus !== "IN_PROGRESS" && build.buildStatus !== "SUCCEEDED") {
      throw new Error(`Existing build ${build.id} is ${build.buildStatus}; no automatic retry`);
    }
    return { action: "observed", buildId: build.id, status: build.buildStatus };
  }
  return { action: builds.some((build) => build.buildStatus === "IN_PROGRESS") ? "wait" : "start" };
}

export function buildsForProject() {
  const { projects } = aws("codebuild", "batch-get-projects", "--names", PROJECT,
    "--query", "{projects:projects[].{name:name,concurrentBuildLimit:concurrentBuildLimit}}");
  if (projects?.length !== 1 || projects[0].name !== PROJECT || projects[0].concurrentBuildLimit !== 1) {
    throw new Error("Production parent must retain concurrentBuildLimit=1");
  }
  // CLI pagination is intentional: an old queued build still makes the project busy.
  // Do not pass sort-order: AWS rejects it on CLI pagination's subsequent pages.
  const { ids } = aws("codebuild", "list-builds-for-project", "--project-name", PROJECT);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.startsWith(`${PROJECT}:`))) {
    throw new Error("Invalid build inventory");
  }
  const builds = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const result = aws("codebuild", "batch-get-builds", "--ids", ...chunk,
      "--query", `{builds:builds[].${BUILD_FIELDS},buildsNotFound:buildsNotFound}`);
    if (!Array.isArray(result.builds) || result.builds.length !== chunk.length ||
        new Set(result.builds.map((build) => build.id)).size !== chunk.length ||
        result.buildsNotFound?.length || result.builds.some((build) => !chunk.includes(build.id))) {
      throw new Error("Incomplete build inventory; refusing to start another build");
    }
    builds.push(...result.builds);
  }
  return builds;
}

export async function retrigger(sha, receiptPath, {
  readBuilds = buildsForProject,
  start = () => aws("codebuild", "start-build", "--project-name", PROJECT,
    "--source-version", sha, "--idempotency-token", `retrigger-${sha}`,
    "--query", `{build:build.${BUILD_FIELDS}}`),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  if (!SHA.test(sha)) throw new Error("Expected a full lowercase commit SHA");
  await sleep(120_000);
  const deadline = now() + 40 * 60_000;
  while (now() < deadline) {
    const decision = decideBuild(readBuilds(), sha);
    if (decision.action === "wait") {
      await sleep(30_000);
      continue;
    }
    if (decision.action === "start") {
      // One attempt only. A concurrent webhook or ambiguous API failure is surfaced,
      // never blindly retried; rerunning the Action checks inventory again first.
      const { build } = start();
      const started = decideBuild([build], sha);
      if (started.action !== "observed") throw new Error("StartBuild returned a different source");
      decision.buildId = started.buildId;
      decision.status = started.status;
    }
    const receipt = { kind: "deploy-retrigger", sha, ...decision };
    writeFileSync(receiptPath, JSON.stringify(receipt));
    console.log(JSON.stringify(receipt));
    return receipt;
  }
  throw new Error("Project stayed busy for 40 minutes; deployment requires operator follow-up");
}

export function guardDeployment(sha, baselinePath) {
  if (!SHA.test(sha)) throw new Error("Expected a full lowercase commit SHA");
  if (command("git", ["rev-parse", "HEAD"]) !== sha) throw new Error("Checkout does not match build SHA");
  const shallow = command("git", ["rev-parse", "--is-shallow-repository"]) === "true";
  command("git", ["fetch", "--no-tags", ...(shallow ? ["--unshallow"] : []),
    "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  command("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const tags = [
    ["AiWorkspaceEcsStack", "ImageTag"],
    ["AiWorkspaceAgentCoreSpikeStack", "AgentImageTag"],
  ].map(([stack, parameter]) => {
    const result = aws("cloudformation", "describe-stacks", "--stack-name", stack,
      "--query", `Stacks[0].{status:StackStatus,tag:Parameters[?ParameterKey==\`${parameter}\`].ParameterValue|[0]}`);
    if (!["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(result?.status) ||
        !SHA.test(result?.tag ?? "")) throw new Error(`Unverifiable deployed state for ${stack}`);
    // Fails closed on older/divergent sources, even with a higher build number.
    try {
      command("git", ["merge-base", "--is-ancestor", result.tag, sha]);
    } catch {
      throw new Error(`Stale or divergent source ${sha}: ${stack} is already at ${result.tag}; refusing rollback`);
    }
    return result.tag;
  });
  let baseline = tags[0];
  if (tags[0] !== tags[1]) {
    // Partial deployments require classification from the older deployed component.
    const ancestor = command("git", ["merge-base", ...tags]);
    if (!tags.includes(ancestor)) throw new Error("Deployed components have diverged");
    baseline = ancestor;
  }
  if (baselinePath) writeFileSync(baselinePath, `export DEPLOYED_COMMIT=${baseline}\n`);
  console.log(JSON.stringify({ kind: "deploy-source-guard", sha, deployed: tags, baseline }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, sha, path] = process.argv.slice(2);
  try {
    if (mode === "guard") guardDeployment(sha, path);
    else if (mode === "retrigger" && path) await retrigger(sha, path);
    else throw new Error("Usage: deploy-retrigger.mjs guard|retrigger SHA [receipt-path]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
