"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
}

// Usage is intentionally absent — the `usage_events` table hasn't landed,
// so the page only renders a "coming soon" placeholder. Showing it as a
// real tab is confusing. Re-add this entry once the table exists:
//   { href: "/admin/usage", label: "Usage" },
const tabs: Tab[] = [
  { href: "/admin", label: "Users" },
  { href: "/admin/tools", label: "Tools" },
  { href: "/admin/runs", label: "Runs" },
  { href: "/admin/audit", label: "Audit" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b border-hairline px-6">
      {tabs.map((t) => {
        const active =
          t.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`relative -mb-px px-3 py-2 text-[13px] ${
              active
                ? "border-b-2 border-ink text-ink"
                : "border-b-2 border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
