import type { Metadata } from "next";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { requirePageRole } from "@/server/auth";

export const metadata: Metadata = { title: "Terminal — FOR-BUD Magazyn" };

const TILES = ["PRZYJĘCIE", "WYDANIE", "SZUKAJ", "LOKALIZACJE"] as const;

function SoonBadge() {
  return (
    <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
      wkrótce
    </span>
  );
}

export default async function MobileHomePage() {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{user.fullName}</div>
          {user.role === "ADMIN" && (
            <Link href="/dashboard" className="text-sm underline underline-offset-4">
              Widok biurowy
            </Link>
          )}
        </div>
        <LogoutButton size="lg" className="h-12 px-5 text-base" />
      </header>

      {/* Kafle nieaktywne do czasu wdrożenia modułów (Etap 3+). */}
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl bg-primary text-4xl font-bold tracking-wide text-primary-foreground opacity-60"
      >
        SKANUJ
        <SoonBadge />
      </button>

      <div className="grid grid-cols-2 gap-4">
        {TILES.map((label) => (
          <button
            key={label}
            type="button"
            disabled
            aria-disabled="true"
            className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border bg-background text-xl font-semibold opacity-60"
          >
            {label}
            <SoonBadge />
          </button>
        ))}
      </div>
    </div>
  );
}
