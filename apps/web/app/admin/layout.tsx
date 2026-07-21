import Link from "next/link";
import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { AdminTabs } from "./AdminTabs";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-canvas text-ink">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-sm font-semibold text-ink">Admin</h1>
          <span className="truncate text-2xs uppercase tracking-wider text-muted">
            Workspace
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <Link href="/chat" className="text-sm text-muted hover:text-ink">
            Back to chat
          </Link>
        </div>
      </header>
      <AdminTabs />
      <main className="flex-1">{children}</main>
    </div>
  );
}
