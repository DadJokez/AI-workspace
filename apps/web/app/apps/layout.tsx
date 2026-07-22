import Link from "next/link";
import { redirect } from "next/navigation";
import { AlphaBadge } from "@/components/AlphaBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

export default async function AppsLayout({
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
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <h1 className="text-sm font-semibold text-ink">
            <Link href="/apps">Apps</Link>
          </h1>
          <AlphaBadge placement="inline" />
          <span className="hidden text-2xs uppercase tracking-wider text-muted sm:inline">
            Workspace
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Link
            href="/skills"
            className="text-sm text-muted hover:text-ink"
          >
            Skills
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
