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
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 border-b border-hairline px-6">
      {tabs.map((t) => {
        const active =
          t.href === "/admin" ? pathname === "/admin" : pathname === t.href;
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
