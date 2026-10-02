import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDelta } from "@/lib/adjustment";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OPERATION_TYPE_LABELS, formatQuantity, formatQuantityUnit, type OperationType } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getDashboardStats, listBelowMinimum } from "@/server/overview";
import { getShortageCount } from "@/server/requirements";
import { listOverRequirement, listOverReserved } from "@/server/reservations";
import { listMovements, type MovementDto } from "@/server/stock";

export const metadata: Metadata = { title: "Dashboard — FOR-BUD Magazyn" };

const DATE_TIME = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const BELOW_MIN_LIMIT = 50;
const RECENT_LIMIT = 15;

const TYPE_BADGE: Record<string, string> = {
  RECEIPT: "bg-emerald-100 text-emerald-900",
  ISSUE: "bg-sky-100 text-sky-900",
  TRANSFER: "bg-violet-100 text-violet-900",
  ADJUSTMENT: "bg-amber-100 text-amber-900",
  REVERSAL: "bg-rose-100 text-rose-900",
};
const typeLabel = (t: string) => (t in OPERATION_TYPE_LABELS ? OPERATION_TYPE_LABELS[t as OperationType] : t);

function Tile({ href, label, value, alert, hint }: { href: string; label: string; value: number; alert?: boolean; hint?: string }) {
  return (
    <Link href={href} className="block rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
      <Card className={alert ? "ring-2 ring-destructive/60" : undefined}>
        <CardContent>
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className={`text-3xl font-semibold ${alert ? "text-destructive" : ""}`}>{formatQuantity(value)}</div>
          {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
        </CardContent>
      </Card>
    </Link>
  );
}

function movementLine(m: MovementDto): string {
  if (m.fromLocationCode !== null && m.toLocationCode !== null) {
    return `${m.fromLocationCode} → ${m.toLocationCode} · ${formatQuantityUnit(Math.abs(m.quantityDelta), m.unit)}`;
  }
  return `${m.locationCode} · ${formatDelta(m.quantityDelta, m.unit)}`;
}

export default async function DashboardPage() {
  const user = await requirePageRole("ADMIN", "BIURO");
  const db = await createSupabaseServerClient();
  // Trzy lekkie zapytania równolegle; wszystko liczy baza (bez pobierania historii).
  const [stats, below, recent, shortages, overReserved, overRequirement] = await Promise.all([
    getDashboardStats(db),
    listBelowMinimum(db, BELOW_MIN_LIMIT),
    listMovements(db, { page: 1, pageSize: RECENT_LIMIT }, { collapseTransfers: true }),
    getShortageCount(db),
    listOverReserved(db),
    listOverRequirement(db),
  ]);

  const today = stats.ok ? stats.data.operationsToday : {};
  const todayTypes = ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "REVERSAL"] as const;

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-muted-foreground">Witaj, {user.fullName}.</p>

      {overReserved.ok && overReserved.data.length > 0 && (
        <section role="alert" className="space-y-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
          <p>
            <strong>Rezerwacje przekraczają stan</strong> — po korekcie lub cofnięciu operacji w magazynie jest mniej, niż
            zarezerwowano dla zleceń. System nie zmniejsza rezerwacji sam: zdecyduj na zleceniach, którą zwolnić.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {overReserved.data.map((m) => (
              <li key={m.materialId}>
                <Link href={`/materialy/${m.materialId}`} className="font-mono underline underline-offset-4">
                  {m.materialCode}
                </Link>{" "}
                {m.materialName}: zarezerwowano {formatQuantityUnit(m.reserved, m.unit)}, na stanie {formatQuantityUnit(m.stockActive, m.unit)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats.ok ? (
        <section aria-label="Podsumowanie" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Tile href="/materialy" label="Aktywne materiały" value={stats.data.activeMaterials} />
          <Tile href="/lokalizacje" label="Aktywne lokalizacje" value={stats.data.activeLocations} />
          <Tile
            href="/magazyn?widok=materialy"
            label="Materiały ze stanem > 0"
            value={stats.data.materialsInStock}
            hint="Lista „Suma per materiał” zawiera też materiały poniżej minimum bez stanu."
          />
          <Tile
            href="/magazyn?widok=materialy&ponizej=1"
            label="Materiały poniżej minimum"
            value={stats.data.belowMinimum}
            alert={stats.data.belowMinimum > 0}
            hint="Liczone od wolnego stanu (stan − rezerwacje zleceń)."
          />
          {shortages.ok && (
            <Tile
              href="/braki"
              label="Materiały z brakiem do zleceń"
              value={shortages.data}
              alert={shortages.data > 0}
              hint="Zapotrzebowanie zleceń (Otwarte, W produkcji) ponad stan magazynu."
            />
          )}
          <Tile
            href="/magazyn?widok=materialy"
            label="Materiały z rezerwacją"
            value={stats.data.reservedMaterials}
            alert={stats.data.overReserved > 0}
            hint={stats.data.overReserved > 0 ? `W tym rezerwacje ponad stan: ${stats.data.overReserved}` : "Rezerwacje zleceń Otwarte / W produkcji."}
          />
          <Tile
            href="#ponad-zapotrzebowanie"
            label="Rezerwacje ponad zapotrzebowanie"
            value={stats.data.overRequirementOrders}
            alert={stats.data.overRequirementOrders > 0}
            hint="Zlecenia z rezerwacją większą niż pozostało do wydania (np. po wycofaniu listy)."
          />
          <Card className="sm:col-span-2 xl:col-span-4">
            <CardHeader>
              <CardTitle>
                Operacje dzisiaj{" "}
                <Link href="/historia" className="ml-2 text-sm font-normal underline underline-offset-4">
                  historia ruchów
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-x-8 gap-y-2">
              {todayTypes
                .filter((t) => t !== "REVERSAL" || (today[t] ?? 0) > 0)
                .map((t) => (
                  <div key={t}>
                    <span className="text-2xl font-semibold">{today[t] ?? 0}</span>{" "}
                    <span className="text-sm text-muted-foreground">{typeLabel(t).toLowerCase()}</span>
                  </div>
                ))}
            </CardContent>
          </Card>
        </section>
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać podsumowania.
        </p>
      )}

      {overRequirement.ok && overRequirement.data.length > 0 && (
        <section id="ponad-zapotrzebowanie" aria-labelledby="over-req-title" className="space-y-3">
          <h2 id="over-req-title" className="text-lg font-semibold">
            Rezerwacje ponad zapotrzebowanie
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {overRequirement.data.map((r) => (
              <li key={`${r.orderId}:${r.materialId}`}>
                <Link href={`/zlecenia/${r.orderId}#rezerwacje`} className="underline underline-offset-4">
                  {r.orderNumber ? `${r.orderNumber} · ` : ""}
                  {r.orderName}
                </Link>{" "}
                — <span className="font-mono">{r.materialCode}</span>: zarezerwowano {formatQuantityUnit(r.reserved, r.unit)}, pozostało do
                wydania {formatQuantityUnit(r.remaining, r.unit)} (nadmiar {formatQuantityUnit(r.excess, r.unit)})
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="below-min-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="below-min-title" className="text-lg font-semibold">
            Poniżej minimum
          </h2>
          <Link href="/magazyn?widok=materialy&ponizej=1" className="text-sm underline underline-offset-4">
            Zobacz w widoku Magazyn
          </Link>
        </div>
        {!below.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać listy.
          </p>
        ) : below.data.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">
            Żaden materiał nie jest poniżej stanu minimalnego.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kod</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead className="text-right">Stan</TableHead>
                  <TableHead className="text-right">Wolne</TableHead>
                  <TableHead className="text-right">Minimum</TableHead>
                  <TableHead className="text-right">Brakuje</TableHead>
                  <TableHead>Domyślny dostawca</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {below.data.map((m) => (
                  <TableRow key={m.materialId}>
                    <TableCell className="font-mono">
                      <Link href={`/materialy/${m.materialId}`} className="underline underline-offset-4">
                        {m.code}
                      </Link>
                    </TableCell>
                    <TableCell>{m.name}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatQuantityUnit(m.totalQuantity, m.unit)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatQuantityUnit(m.freeQuantity, m.unit)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {formatQuantityUnit(m.minQuantity ?? 0, m.unit)}
                    </TableCell>
                    <TableCell className="text-right font-semibold whitespace-nowrap text-destructive">
                      {formatQuantityUnit(m.shortage, m.unit)}
                    </TableCell>
                    <TableCell>{m.defaultSupplierName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {below.ok && stats.ok && stats.data.belowMinimum > below.data.length && (
          <p className="text-sm text-muted-foreground">
            Pokazano {below.data.length} z {stats.data.belowMinimum} (największe braki).
          </p>
        )}
      </section>

      <section aria-labelledby="recent-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-title" className="text-lg font-semibold">
            Ostatnie operacje
          </h2>
          <Link href="/historia" className="text-sm underline underline-offset-4">
            Cała historia
          </Link>
        </div>
        {!recent.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać operacji.
          </p>
        ) : recent.data.items.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak operacji.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead>Materiał</TableHead>
                  <TableHead>Lokalizacja / ilość</TableHead>
                  <TableHead>Użytkownik</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.data.items.map((m) => (
                  <TableRow key={m.movementId}>
                    <TableCell className="whitespace-nowrap">{DATE_TIME.format(new Date(m.createdAt))}</TableCell>
                    <TableCell>
                      <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap ${TYPE_BADGE[m.type] ?? "bg-muted"}`}>
                        {typeLabel(m.type)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Link href={`/materialy/${m.materialId}`} className="font-mono underline underline-offset-4">
                        {m.materialCode}
                      </Link>
                      <div className="text-xs text-muted-foreground">{m.materialName}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{movementLine(m)}</TableCell>
                    <TableCell>{m.userName}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
