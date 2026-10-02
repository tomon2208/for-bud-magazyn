import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { formatQuantity } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getOrder, getOrderIssueSummary } from "@/server/orders";
import { getOrderShortages, listRequirements } from "@/server/requirements";
import { listMovements } from "@/server/stock";
import { OrderHeader } from "./order-header";
import { RequirementsSection } from "./requirements-section";

export const metadata: Metadata = { title: "Zlecenie — FOR-BUD Magazyn" };

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

// Szczegóły zlecenia: dane i status, zapotrzebowanie (listy), braki zlecenia, podsumowanie wydań per materiał,
// ostatnie wydania (pełna lista — „Wydania”).
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
  const [requirements, shortages, summary, issues] = await Promise.all([
    listRequirements(db, id.data),
    getOrderShortages(db, id.data),
    getOrderIssueSummary(db, id.data),
    listMovements(db, { type: "ISSUE", orderId: id.data, page: 1, pageSize: 100 }),
  ]);
  const o = order.data;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <Link href="/zlecenia" className="text-sm underline underline-offset-4">
          ← Zlecenia
        </Link>
        <OrderHeader order={o} />
      </div>

      {requirements.ok ? (
        <RequirementsSection orderId={o.id} orderStatus={o.status} requirements={requirements.data} canEdit />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać zapotrzebowania.
        </p>
      )}

      <section id="braki" className="space-y-3" aria-labelledby="shortages-title">
        <h2 id="shortages-title" className="text-lg font-semibold">
          Braki zlecenia
        </h2>
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
          „Dostępne” jest wspólne dla wszystkich zleceń — ten sam stan może pokrywać kilka zleceń naraz. Prawdziwe braki do
          zamówienia pokazuje strona{" "}
          <Link href="/braki" className="font-medium underline underline-offset-4">
            Braki
          </Link>{" "}
          (do czasu wprowadzenia rezerwacji).
        </p>
        {!shortages.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać braków.
          </p>
        ) : shortages.data.length === 0 ? (
          <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak aktywnych list zapotrzebowania.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kod</TableHead>
                  <TableHead>Nazwa</TableHead>
                  <TableHead>Jedn.</TableHead>
                  <TableHead className="text-right">Potrzebne</TableHead>
                  <TableHead className="text-right">Wydano</TableHead>
                  <TableHead className="text-right">Pozostało</TableHead>
                  <TableHead className="text-right">Dostępne</TableHead>
                  <TableHead className="text-right">Brakuje</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shortages.data.map((r) => (
                  <TableRow key={r.materialId} className={r.shortage > 0 ? "bg-destructive/10" : undefined}>
                    <TableCell className="font-mono">
                      <Link href={`/materialy/${r.materialId}`} className="underline underline-offset-4">
                        {r.materialCode}
                      </Link>
                    </TableCell>
                    <TableCell>{r.materialName}</TableCell>
                    <TableCell>{r.unit}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.needed)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.issued)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.remaining)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.available)}</TableCell>
                    <TableCell className={`text-right font-semibold ${r.shortage > 0 ? "text-destructive" : ""}`}>
                      {r.shortage > 0 ? formatQuantity(r.shortage) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

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
