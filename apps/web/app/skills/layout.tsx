import Link from "next/link";
import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

export default async function SkillsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    redirect("/login");
  }
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-hairline px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-ink">
            <Link href="/skills">Skills</Link>
          </h1>
          <span className="text-2xs uppercase tracking-wider text-muted">
            Workspace
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/apps" className="text-sm text-muted hover:text-ink">
            Apps
          </Link>
          <ThemeToggle />
          <Link href="/chat" className="text-sm text-muted hover:text-ink">
            Back to chat
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1">{children}</main>
    </div>
  );
}
