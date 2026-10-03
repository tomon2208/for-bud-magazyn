import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDelta } from "@/lib/adjustment";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { OPERATION_TYPE_LABELS, formatQuantity, formatQuantityUnit, type OperationType } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getMaterial } from "@/server/catalog";
import { getMaterialTotal } from "@/server/overview";
import { getMaterialAvailability } from "@/server/reservations";
import { listMovements, listStock, type MovementDto } from "@/server/stock";

export const metadata: Metadata = { title: "Materiał — FOR-BUD Magazyn" };

const DATE_TIME = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const typeLabel = (t: string) => (t in OPERATION_TYPE_LABELS ? OPERATION_TYPE_LABELS[t as OperationType] : t);

function movementLine(m: MovementDto): string {
  if (m.fromLocationCode !== null && m.toLocationCode !== null) {
    return `${m.fromLocationCode} → ${m.toLocationCode} · ${formatQuantityUnit(Math.abs(m.quantityDelta), m.unit)}`;
  }
  return `${m.locationCode} · ${formatDelta(m.quantityDelta, m.unit)}`;
}

// Szczegóły materiału (ADMIN, BIURO): kartoteka, stan łączny, rozbicie po lokalizacjach, ostatnie ruchy.
export default async function MaterialDetailsPage({ params }: PageProps<"/materialy/[id]">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const id = entityIdSchema.safeParse((await params).id);
  if (!id.success) notFound();

  const db = await createSupabaseServerClient();
  const [material, total, stock, moves, availability] = await Promise.all([
    getMaterial(db, id.data),
    getMaterialTotal(db, id.data),
    listStock(db, { materialId: id.data, page: 1, pageSize: 200 }),
    listMovements(db, { materialId: id.data, page: 1, pageSize: 10 }, { collapseTransfers: true }),
    getMaterialAvailability(db, id.data),
  ]);
  const av = availability.ok ? availability.data : null;
  if (!material.ok) {
    if (material.error.status === 404) notFound();
    return (
      <p role="alert" className="text-destructive">
        Nie udało się wczytać materiału.
      </p>
    );
  }
  const m = material.data;
  const t = total.ok ? total.data : null;

  return (
    <div className="max-w-5xl space-y-6">
      <div className="text-sm">
        <Link href="/magazyn?widok=materialy" className="underline underline-offset-4">
          ← Magazyn
        </Link>
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">
          <span className="font-mono">{m.code}</span> — {m.name}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{m.categoryName}</span>
          <span>·</span>
          <span>
            jednostka: {m.unit}
            {m.allowsFraction ? " (ułamki)" : ""}
          </span>
          {m.barLengthM !== null && (
            <>
              <span>·</span>
              <span>długość sztangi: {formatQuantity(m.barLengthM)} m</span>
            </>
          )}
          <span>·</span>
          <span>dostawca: {m.defaultSupplierName ?? "—"}</span>
          {!m.active && <Badge variant="destructive">nieaktywny</Badge>}
        </div>
        {m.notes && <p className="text-sm">{m.notes}</p>}
      </header>

      <Card className={t?.belowMinimum ? "ring-2 ring-destructive/60" : undefined}>
        <CardHeader>
          <CardTitle>Stan łączny</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="text-3xl font-semibold">{formatQuantityUnit(t?.totalQuantity ?? 0, m.unit)}</div>
          <div className="text-sm text-muted-foreground">
            Minimum: {m.minQuantity === null ? "nie ustawiono" : formatQuantityUnit(m.minQuantity, m.unit)}
            {user.role === "ADMIN" && (
              <>
                {" · "}
                <Link href={`/materialy?q=${encodeURIComponent(m.code)}`} className="underline underline-offset-4">
                  zmień w kartotece
                </Link>
              </>
            )}
          </div>
          {t?.belowMinimum && (
            <p className="text-sm font-semibold text-destructive">
              Poniżej minimum — brakuje {formatQuantityUnit(t.shortage, m.unit)}.
            </p>
          )}
          {av && (
            <div className="text-sm">
              Zarezerwowane: <strong>{formatQuantityUnit(av.reservedTotal, m.unit)}</strong> · Wolne:{" "}
              <strong>{formatQuantityUnit(av.free, m.unit)}</strong>
              <span className="text-muted-foreground"> (minimum porównujemy z wolnym stanem)</span>
            </div>
          )}
          {av?.overReserved && (
            <p role="alert" className="rounded-md bg-amber-50 p-2 text-sm text-amber-950">
              Rezerwacje przekraczają stan ({formatQuantityUnit(av.reservedTotal, m.unit)} &gt; {formatQuantityUnit(av.stockActive, m.unit)}) —
              zdecyduj na zleceniu, którą rezerwację zwolnić.
            </p>
          )}
        </CardContent>
      </Card>

      {av && av.orders.length > 0 && (
        <section aria-labelledby="reservations" className="space-y-3">
          <h2 id="reservations" className="text-lg font-semibold">
            Rezerwacje zleceń
          </h2>
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zlecenie</TableHead>
                  <TableHead className="text-right">Zarezerwowane</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {av.orders.map((o) => (
                  <TableRow key={o.orderId}>
                    <TableCell>
                      <Link href={`/zlecenia/${o.orderId}#rezerwacje`} className="underline underline-offset-4">
                        {o.number ? `${o.number} · ` : ""}
                        {o.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatQuantityUnit(o.quantity, m.unit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <section aria-labelledby="by-location" className="space-y-3">
        <h2 id="by-location" className="text-lg font-semibold">
          Lokalizacje
        </h2>
        {!stock.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać stanów.
          </p>
        ) : stock.data.items.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak stanu w jakiejkolwiek lokalizacji.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lokalizacja</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  {user.role === "ADMIN" && <TableHead className="w-24" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.data.items.map((r) => (
                  <TableRow key={r.locationId}>
                    <TableCell className="font-mono">
                      {r.locationCode}
                      {!r.locationActive && <span className="ml-1 font-sans text-xs text-destructive">(nieaktywna)</span>}
                    </TableCell>
                    <TableCell>{r.locationName ?? "—"}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className="font-semibold">{formatQuantity(r.quantity)}</span> {r.unit}
                    </TableCell>
                    {user.role === "ADMIN" && (
                      <TableCell className="text-right">
                        <Link
                          href={`/magazyn/korekta?material=${r.materialId}&lokalizacja=${r.locationId}`}
                          className="text-sm underline underline-offset-4"
                        >
                          Koryguj
                        </Link>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {stock.ok && stock.data.total > stock.data.items.length && (
          <p className="text-sm text-muted-foreground">
            Pokazano {stock.data.items.length} z {stock.data.total} lokalizacji.
          </p>
        )}
      </section>

      <section aria-labelledby="recent-moves" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="recent-moves" className="text-lg font-semibold">
            Ostatnie ruchy
          </h2>
          <Link href={`/historia?material=${m.id}`} className="text-sm underline underline-offset-4">
            Pełna historia tego materiału
          </Link>
        </div>
        {!moves.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać ruchów.
          </p>
        ) : moves.data.items.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak ruchów.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead>Lokalizacja / ilość</TableHead>
                  <TableHead>Użytkownik</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {moves.data.items.map((mv) => (
                  <TableRow key={mv.movementId}>
                    <TableCell className="whitespace-nowrap">{DATE_TIME.format(new Date(mv.createdAt))}</TableCell>
                    <TableCell>{typeLabel(mv.type)}</TableCell>
                    <TableCell className="whitespace-nowrap">{movementLine(mv)}</TableCell>
                    <TableCell>{mv.userName}</TableCell>
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
