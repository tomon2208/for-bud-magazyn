"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:bg-muted",
        active && "bg-muted text-foreground",
        !active && "text-muted-foreground",
      )}
    >
      {children}
    </Link>
  );
}
