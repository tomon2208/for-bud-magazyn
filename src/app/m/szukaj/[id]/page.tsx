import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { formatQuantity } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getMaterialTotal } from "@/server/overview";
import { listStock } from "@/server/stock";
import { BackLink } from "../../back-link";
import { locationHref } from "../../lokalizacje/href";

export const metadata: Metadata = { title: "Materiał — FOR-BUD Magazyn" };

// Ekran materiału: stan łączny + gdzie leży (lokalizacje z ilościami, klik → ekran lokalizacji).
export default async function MobileMaterialPage({ params, searchParams }: PageProps<"/m/szukaj/[id]">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const id = entityIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const rawQ = (await searchParams).q;
  const q = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.slice(0, 100) ?? "";
  const backHref = q ? `/m/szukaj?q=${encodeURIComponent(q)}` : "/m/szukaj";

  const db = await createSupabaseServerClient();
  const [total, stock] = await Promise.all([
    getMaterialTotal(db, id.data),
    listStock(db, { materialId: id.data, page: 1, pageSize: 200 }),
  ]);
  if (total.ok && total.data === null) notFound();

  if (!total.ok || !total.data) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header>
          <BackLink href={backHref}>Szukaj</BackLink>
        </header>
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-destructive">
          Nie udało się wczytać materiału.
        </p>
      </div>
    );
  }
  const m = total.data;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header>
        <BackLink href={backHref}>Szukaj</BackLink>
      </header>

      <section className="rounded-2xl border bg-background p-5 text-center">
        <h1 className="font-mono text-4xl leading-tight font-extrabold break-all">{m.code}</h1>
        <p className="mt-2 text-xl">{m.name}</p>
        {!m.active && <p className="mt-2 text-base font-semibold text-destructive">Materiał nieaktywny</p>}
        <p className="mt-4 text-sm text-muted-foreground">Stan łączny</p>
        <p className="text-5xl font-extrabold">
          {formatQuantity(m.totalQuantity)} <span className="text-2xl font-semibold">{m.unit}</span>
        </p>
        {m.belowMinimum && (
          <p role="status" className="mt-3 rounded-xl bg-rose-100 p-3 text-lg font-semibold text-rose-900">
            Poniżej minimum ({formatQuantity(m.minQuantity ?? 0)} {m.unit}) — brakuje {formatQuantity(m.shortage)} {m.unit}
          </p>
        )}
      </section>

      <section className="rounded-2xl border bg-background p-4">
        <h2 className="mb-2 text-lg font-semibold">Gdzie leży</h2>
        {!stock.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać lokalizacji.
          </p>
        ) : stock.data.items.length === 0 ? (
          <p className="text-lg text-muted-foreground">Brak na stanie.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {stock.data.items.map((r) => (
              <li key={r.locationId}>
                <Link
                  href={locationHref(r.locationCode)}
                  className="flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 py-2 active:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-2xl font-bold break-all">{r.locationCode}</span>
                    {(r.locationName || !r.locationActive) && (
                      <span className="block text-base text-muted-foreground">
                        {r.locationName ?? ""}
                        {!r.locationActive ? " (nieaktywna)" : ""}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-2xl font-bold whitespace-nowrap">
                    {formatQuantity(r.quantity)} <span className="text-base font-medium">{r.unit}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {stock.ok && stock.data.total > stock.data.items.length && (
          <p className="mt-2 text-center text-muted-foreground">
            Pokazano {stock.data.items.length} z {stock.data.total} lokalizacji.
          </p>
        )}
      </section>
    </div>
  );
}
