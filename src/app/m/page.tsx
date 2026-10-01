import type { Metadata } from "next";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatQuantityUnit } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listMyRecentReceipts } from "@/server/stock";
import { PendingReceiptBanner } from "./pending-banner";

export const metadata: Metadata = { title: "Terminal — FOR-BUD Magazyn" };

const SOON_TILES = ["WYDANIE", "SZUKAJ"] as const;

function SoonBadge() {
  return (
    <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
      wkrótce
    </span>
  );
}

const TIME = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric", timeZone: "Europe/Warsaw" });
const DAY_MS = 24 * 60 * 60 * 1000;
/** Początek okna „ostatnie 24 h” (czas żądania). */
const last24h = () => new Date(Date.now() - DAY_MS).toISOString();

const TILE_BASE = "flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border text-xl font-semibold";

export default async function MobileHomePage() {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const since = last24h();
  const mine = await listMyRecentReceipts(await createSupabaseServerClient(), user.id, { since, limit: 10 });

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

      <PendingReceiptBanner userId={user.id} />

      <Link
        href="/m/skanuj"
        className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl bg-primary text-4xl font-bold tracking-wide text-primary-foreground active:opacity-80"
      >
        SKANUJ
      </Link>

      <div className="grid grid-cols-2 gap-4">
        <Link href="/m/przyjecie" className={`${TILE_BASE} bg-background active:bg-muted`}>
          PRZYJĘCIE
        </Link>
        {/* Kafle nieaktywne do czasu wdrożenia modułów (Etap 5+). */}
        {SOON_TILES.map((label) => (
          <button
            key={label}
            type="button"
            disabled
            aria-disabled="true"
            className={`${TILE_BASE} bg-background opacity-60`}
          >
            {label}
            <SoonBadge />
          </button>
        ))}
        <Link href="/m/lokalizacje" className={`${TILE_BASE} bg-background active:bg-muted`}>
          LOKALIZACJE
        </Link>
      </div>

      <section className="rounded-2xl border bg-background p-4">
        <h2 className="mb-2 text-lg font-semibold">Moje ostatnie przyjęcia (24 h)</h2>
        {!mine.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać przyjęć.
          </p>
        ) : mine.data.length === 0 ? (
          <p className="text-muted-foreground">Brak przyjęć w ostatnich 24 godzinach.</p>
        ) : (
          <ul className="divide-y">
            {mine.data.map((r) => (
              <li key={r.movementId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="font-mono font-bold break-all">{r.materialCode}</div>
                  <div className="text-sm text-muted-foreground">
                    {TIME.format(new Date(r.createdAt))} · {r.locationCode}
                  </div>
                </div>
                <div className="shrink-0 text-lg font-bold whitespace-nowrap">{formatQuantityUnit(r.quantity, r.unit)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
