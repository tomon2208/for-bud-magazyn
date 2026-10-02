import type { Metadata } from "next";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatQuantityUnit, issueReasonLabel, reasonLabel } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listMyRecentOperations, type MyOperationDto } from "@/server/stock";
import { PendingOperationsBanner } from "./pending-banner";

export const metadata: Metadata = { title: "Terminal — FOR-BUD Magazyn" };

const TIME = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric", timeZone: "Europe/Warsaw" });
const DAY_MS = 24 * 60 * 60 * 1000;
/** Początek okna „ostatnie 24 h” (czas żądania). */
const last24h = () => new Date(Date.now() - DAY_MS).toISOString();

const TILE_BIG = "flex min-h-32 flex-col items-center justify-center gap-2 rounded-2xl border text-xl font-semibold";
const TILE_SMALL = "flex min-h-16 flex-col items-center justify-center rounded-2xl border px-2 text-base font-semibold";

const TYPE_LABEL: Record<string, { text: string; className: string }> = {
  RECEIPT: { text: "Przyjęcie", className: "bg-emerald-100 text-emerald-900" },
  ISSUE: { text: "Wydanie", className: "bg-sky-100 text-sky-900" },
  TRANSFER: { text: "Przesunięcie", className: "bg-violet-100 text-violet-900" },
  ADJUSTMENT: { text: "Korekta", className: "bg-amber-100 text-amber-900" },
};

function describe(op: MyOperationDto): string {
  if (op.type === "RECEIPT") return `→ ${op.locationCode}`;
  if (op.type === "TRANSFER") return `${op.locationCode} → ${op.toLocationCode ?? "?"}`;
  if (op.type === "ADJUSTMENT") return `${op.locationCode} · ${reasonLabel(op.type, op.reasonCode)}`;
  return `z ${op.locationCode} · ${op.orderName ?? issueReasonLabel(op.reasonCode)}`;
}

export default async function MobileHomePage() {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const since = last24h();
  const mine = await listMyRecentOperations(await createSupabaseServerClient(), user.id, { since, limit: 10 });

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

      <PendingOperationsBanner userId={user.id} />

      <Link
        href="/m/skanuj"
        className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl bg-primary text-4xl font-bold tracking-wide text-primary-foreground active:opacity-80"
      >
        SKANUJ
      </Link>

      <div className="grid grid-cols-2 gap-4">
        <Link href="/m/przyjecie" className={`${TILE_BIG} bg-background active:bg-muted`}>
          PRZYJĘCIE
        </Link>
        <Link href="/m/wydanie" className={`${TILE_BIG} bg-background active:bg-muted`}>
          WYDANIE
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Link href="/m/przesuniecie" className={`${TILE_SMALL} bg-background active:bg-muted`}>
          PRZESUNIĘCIE
        </Link>
        <Link href="/m/lokalizacje" className={`${TILE_SMALL} bg-background active:bg-muted`}>
          LOKALIZACJE
        </Link>
        <Link href="/m/szukaj" className={`${TILE_SMALL} col-span-2 bg-background active:bg-muted`}>
          SZUKAJ
        </Link>
      </div>

      <section className="rounded-2xl border bg-background p-4">
        <h2 className="mb-2 text-lg font-semibold">Moje ostatnie operacje (24 h)</h2>
        {!mine.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać operacji.
          </p>
        ) : mine.data.length === 0 ? (
          <p className="text-muted-foreground">Brak operacji w ostatnich 24 godzinach.</p>
        ) : (
          <ul className="divide-y">
            {mine.data.map((r) => (
              <li key={r.operationId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-1.5 text-xs font-semibold ${TYPE_LABEL[r.type]?.className ?? "bg-muted"}`}>
                      {TYPE_LABEL[r.type]?.text ?? r.type}
                    </span>
                    <span className="font-mono font-bold break-all">{r.materialCode}</span>
                    {r.reversed && (
                      <span className="rounded-md bg-rose-100 px-1.5 text-xs font-semibold text-rose-900">cofnięto</span>
                    )}
                  </div>
                  <div className="text-sm break-words text-muted-foreground">
                    {TIME.format(new Date(r.createdAt))} · {describe(r)}
                  </div>
                </div>
                <div className="shrink-0 text-lg font-bold whitespace-nowrap">
                  {r.type === "ISSUE" || (r.type === "ADJUSTMENT" && r.delta < 0) ? "−" : r.type === "ADJUSTMENT" ? "+" : ""}
                  {formatQuantityUnit(r.quantity, r.unit)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
