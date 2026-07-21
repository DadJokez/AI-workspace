import { MODEL_IDS } from "@ai-workspace/agent";
import Link from "next/link";
import { ImportSkillPanel } from "@/components/skills/ImportSkillPanel";
import { SkillForm } from "@/components/skills/SkillForm";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

export default function NewSkillPage() {
  return (
    <section className="px-6 py-6">
      <div className="pb-4">
        <Link href="/skills" className="text-xs text-muted hover:text-ink">
          ← Back to catalog
        </Link>
        <h2 className="mt-2 text-base font-semibold text-ink">New skill</h2>
        <p className="mt-1 text-xs text-muted">
          Describe what the agent should do when this skill runs. Tools are
          mounted only if the running user has connected and approved them.
        </p>
      </div>
      <SkillForm
        mode="create"
        modelOptions={[...MODEL_IDS]}
        providerOptions={SUPPORTED_MCP_PROVIDERS}
      />
      <div className="mt-4 border-t border-hairline pt-4">
        <ImportSkillPanel />
      </div>
    </section>
  );
}
