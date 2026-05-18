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
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-hairline px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-ink">Admin</h1>
          <span className="text-[11px] uppercase tracking-wider text-muted">
            Workspace
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/chat" className="text-[13px] text-muted hover:text-ink">
            Back to chat
          </Link>
        </div>
      </header>
      <AdminTabs />
      <main className="flex-1">{children}</main>
    </div>
  );
}
