"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
}

const tabs: Tab[] = [
  { href: "/admin", label: "Users" },
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/tools", label: "Tools" },
  { href: "/admin/runs", label: "Runs" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/feedback", label: "Feedback" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin sections"
      className="overflow-x-auto border-b border-hairline px-3 sm:px-6"
    >
      <div className="flex min-w-max items-center gap-1">
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
              className={`relative -mb-px whitespace-nowrap px-3 py-2 text-sm ${
                active
                  ? "border-b-2 border-ink text-ink"
                  : "border-b-2 border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
