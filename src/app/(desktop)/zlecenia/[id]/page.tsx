import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { formatQuantity } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getOrder, getOrderIssueSummary } from "@/server/orders";
import { listMovements } from "@/server/stock";
import { StatusBadge } from "../orders-view";

export const metadata: Metadata = { title: "Zlecenie — FOR-BUD Magazyn" };

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

// Szczegóły zlecenia: dane, podsumowanie wydań per materiał, ostatnie wydania (pełna lista — „Wydania”).
export default async function OrderDetailsPage({ params }: PageProps<"/zlecenia/[id]">) {
  await requirePageRole("ADMIN", "BIURO");
  const id = entityIdSchema.safeParse((await params).id);
  if (!id.success) notFound();

  const db = await createSupabaseServerClient();
  const order = await getOrder(db, id.data);
  if (!order.ok) {
    if (order.error.status === 404) notFound();
    return (
      <p role="alert" className="text-destructive">
        Nie udało się wczytać zlecenia.
      </p>
    );
  }
  const [summary, issues] = await Promise.all([
    getOrderIssueSummary(db, id.data),
    listMovements(db, { type: "ISSUE", orderId: id.data, page: 1, pageSize: 100 }),
  ]);
  const o = order.data;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-1">
        <Link href="/zlecenia" className="text-sm underline underline-offset-4">
          ← Zlecenia
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
          {o.name} <StatusBadge status={o.status} />
        </h1>
        <p className="text-sm text-muted-foreground">Utworzono {DATE.format(new Date(o.createdAt))}</p>
        {o.notes && <p className="max-w-3xl text-sm whitespace-pre-line">{o.notes}</p>}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Wydane materiały (suma)</h2>
        {!summary.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać podsumowania.
          </p>
        ) : summary.data.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">Na to zlecenie nic jeszcze nie wydano.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Materiał</TableHead>
                  <TableHead className="text-right">Wydano (netto)</TableHead>
                  <TableHead className="text-right">Liczba wydań</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.data.map((s) => (
                  <TableRow key={s.materialId}>
                    <TableCell>
                      <span className="font-mono">{s.materialCode}</span>
                      <div className="text-xs text-muted-foreground">{s.materialName}</div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className="font-semibold">{formatQuantity(s.quantity)}</span> {s.unit}
                    </TableCell>
                    <TableCell className="text-right">
                      {s.issues}
                      {s.reversals > 0 && <span className="text-muted-foreground"> (cofnięto: {s.reversals})</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Wydania na zlecenie</h2>
          <Link href={`/wydania?zlecenie=${o.id}`} className="text-sm underline underline-offset-4">
            Pokaż w „Wydaniach” (filtry, strony)
          </Link>
        </div>
        {!issues.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać wydań.
          </p>
        ) : issues.data.items.length === 0 ? (
          <p className="text-muted-foreground">Brak wydań.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Użytkownik</TableHead>
                  <TableHead>Materiał</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead>Lokalizacja</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.data.items.map((m) => (
                  <TableRow key={m.movementId}>
                    <TableCell className="whitespace-nowrap">{DATE.format(new Date(m.createdAt))}</TableCell>
                    <TableCell>{m.userName}</TableCell>
                    <TableCell>
                      <span className="font-mono">{m.materialCode}</span>
                      <div className="text-xs text-muted-foreground">{m.materialName}</div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className="font-semibold">{formatQuantity(-m.quantityDelta)}</span> {m.unit}
                    </TableCell>
                    <TableCell className="font-mono">
                      {m.locationCode}
                      {m.reversedAt && (
                        <Link href={`/historia?operacja=${m.operationId}`} className="ml-2 font-sans text-xs text-rose-800 underline underline-offset-4">
                          cofnięto
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {issues.data.total > issues.data.items.length && (
              <p className="p-3 text-sm text-muted-foreground">
                Pokazano {issues.data.items.length} z {issues.data.total}. Pełna lista — w „Wydaniach”.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
