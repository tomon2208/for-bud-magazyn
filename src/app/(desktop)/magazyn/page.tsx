import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listStockQuerySchema, listTotalsQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listCategories } from "@/server/catalog";
import { listMaterialTotals } from "@/server/overview";
import { listStock } from "@/server/stock";
import { StockView, type StockFilters } from "./stock-view";

export const metadata: Metadata = { title: "Magazyn — FOR-BUD Magazyn" };

const PAGE_SIZE = 50;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Zły parametr w URL ignorujemy POJEDYNCZO (pozostałe filtry zostają): wyrzucamy pola wskazane w błędach
 * walidacji i parsujemy ponownie.
 */
function parseIgnoringBad<T extends typeof listStockQuerySchema | typeof listTotalsQuerySchema>(
  schema: T,
  raw: Record<string, string | undefined>,
): ReturnType<T["parse"]> {
  const input = { ...raw };
  for (let i = 0; i < 6; i++) {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data as ReturnType<T["parse"]>;
    for (const issue of parsed.error.issues) delete input[String(issue.path[0])];
  }
  return schema.parse({ pageSize: raw.pageSize }) as ReturnType<T["parse"]>;
}

// Stany magazynowe (ADMIN, BIURO): „per lokalizacja” albo „suma per materiał”; filtry w URL, paginacja w SQL.
export default async function StockPage({ searchParams }: PageProps<"/magazyn">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const mode = firstParam(raw.widok) === "materialy" ? "materialy" : "lokalizacje";
  const common = {
    q: firstParam(raw.q),
    categoryId: firstParam(raw.kategoria),
    belowMin: firstParam(raw.ponizej) === "1" ? "1" : undefined,
    page: firstParam(raw.page),
    pageSize: String(PAGE_SIZE),
  };

  // Nieprawidłowe parametry w URL ignorujemy (wartości domyślne) zamiast pokazywać błąd.
  const db = await createSupabaseServerClient();
  const schema = mode === "materialy" ? listTotalsQuerySchema : listStockQuerySchema;
  const query = parseIgnoringBad(schema, common);

  const [categories, locations, totals] = await Promise.all([
    listCategories(db, { includeInactive: true }),
    mode === "lokalizacje" ? listStock(db, query as ReturnType<typeof listStockQuerySchema.parse>) : null,
    mode === "materialy" ? listMaterialTotals(db, query as ReturnType<typeof listTotalsQuerySchema.parse>) : null,
  ]);

  const filters: StockFilters = {
    mode,
    q: query.q ?? "",
    categoryId: query.categoryId ?? "",
    belowMin: query.belowMin === true,
  };
  const result = mode === "lokalizacje" ? locations : totals;

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Magazyn — stany</h1>
      {result?.ok && categories.ok ? (
        <StockView
          filters={filters}
          categories={categories.data}
          canAdjust={user.role === "ADMIN"}
          locations={locations?.ok ? locations.data : null}
          totals={totals?.ok ? totals.data : null}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać stanów.
        </p>
      )}
    </div>
  );
}
