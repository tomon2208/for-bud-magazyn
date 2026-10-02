import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { listCategories, listSuppliers } from "@/server/catalog";
import { listShortages } from "@/server/requirements";
import { ShortagesView } from "./shortages-view";

export const metadata: Metadata = { title: "Braki — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const validId = (v: string | undefined) => (v && entityIdSchema.safeParse(v).success ? v : undefined);

// Braki zbiorczo (ADMIN, BIURO): per materiał, po zleceniach Otwarte + W produkcji. Filtry w URL:
// dostawca, kategoria, braki=0 (pokaż też materiały z pokryciem; domyślnie tylko z brakiem).
export default async function ShortagesPage({ searchParams }: PageProps<"/braki">) {
  await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const supplier = validId(first(raw.dostawca));
  const category = validId(first(raw.kategoria));
  const onlyShort = first(raw.braki) !== "0";

  const db = await createSupabaseServerClient();
  const [result, suppliers, categories] = await Promise.all([
    listShortages(db, { supplier, category, onlyShort }),
    listSuppliers(db, { includeInactive: true }),
    listCategories(db, { includeInactive: true }),
  ]);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Braki do zleceń</h1>
      {result.ok && suppliers.ok && categories.ok ? (
        <ShortagesView
          items={result.data.items}
          total={result.data.total}
          suppliers={suppliers.data.map((s) => ({ id: s.id, name: s.name }))}
          categories={categories.data.map((c) => ({ id: c.id, name: c.name }))}
          filters={{ supplier: supplier ?? "", category: category ?? "", onlyShort }}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać braków.
        </p>
      )}
    </div>
  );
}
