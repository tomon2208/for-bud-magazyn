import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatQuantity, listTotalsQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listMaterialTotals } from "@/server/overview";
import { BackLink } from "../back-link";
import { MaterialSearch } from "./material-search";

export const metadata: Metadata = { title: "Szukaj — FOR-BUD Magazyn" };

const LIMIT = 30;

// Terminal: „gdzie leży X i ile tego jest?” — wyszukiwanie materiału po kodzie/nazwie z łącznym stanem.
export default async function MobileSearchPage({ searchParams }: PageProps<"/m/szukaj">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const raw = (await searchParams).q;
  const parsed = listTotalsQuerySchema.safeParse({ q: Array.isArray(raw) ? raw[0] : raw, pageSize: String(LIMIT) });
  const q = parsed.success ? (parsed.data.q ?? "") : "";

  const result = q ? await listMaterialTotals(await createSupabaseServerClient(), { page: 1, pageSize: LIMIT, q, allActive: true }) : null;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <BackLink />
        <h1 className="pr-3 text-xl font-bold">Szukaj</h1>
      </header>

      <MaterialSearch initial={q} />

      {result === null ? (
        <p className="rounded-xl border bg-background p-6 text-center text-lg text-muted-foreground">
          Wpisz kod lub nazwę materiału.
        </p>
      ) : !result.ok ? (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-destructive">
          Nie udało się wyszukać materiałów.
        </p>
      ) : result.data.items.length === 0 ? (
        <p className="rounded-xl border bg-background p-6 text-center text-lg text-muted-foreground">
          Brak materiałów dla tej frazy.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {result.data.items.map((m) => (
              <li key={m.materialId}>
                <Link
                  href={`/m/szukaj/${m.materialId}?q=${encodeURIComponent(q)}`}
                  className="flex min-h-16 flex-col justify-center gap-0.5 rounded-xl border bg-background px-4 py-2 active:bg-muted"
                >
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span className="font-mono text-xl font-bold break-all">{m.code}</span>
                    <span className={`shrink-0 text-xl font-bold whitespace-nowrap ${m.totalQuantity > 0 ? "" : "text-muted-foreground"}`}>
                      {formatQuantity(m.totalQuantity)} <span className="text-base font-medium">{m.unit}</span>
                    </span>
                  </span>
                  <span className="text-base text-muted-foreground">{m.name}</span>
                  {m.reservedQuantity > 0 && (
                    <span className="text-sm text-muted-foreground">
                      zarezerwowane {formatQuantity(m.reservedQuantity)} · wolne {formatQuantity(m.freeQuantity)}
                    </span>
                  )}
                  {m.belowMinimum && (
                    <span className="w-fit rounded-md bg-rose-100 px-2 py-0.5 text-sm font-semibold text-rose-900">
                      poniżej minimum
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          {result.data.total > result.data.items.length && (
            <p className="text-center text-muted-foreground">
              Pokazano {result.data.items.length} z {result.data.total}. Zawęź wyszukiwanie.
            </p>
          )}
        </>
      )}
    </div>
  );
}
