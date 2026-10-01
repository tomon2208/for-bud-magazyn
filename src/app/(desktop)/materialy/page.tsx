import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMaterialsQuerySchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { listCategories, listMaterials, listSuppliers } from "@/server/catalog";
import { MaterialsView } from "./materials-view";

export const metadata: Metadata = { title: "Materiały — FOR-BUD Magazyn" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function MaterialsPage({ searchParams }: PageProps<"/materialy">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;

  // Nieprawidłowe parametry w URL ignorujemy (wartości domyślne) zamiast pokazywać błąd.
  const parsed = listMaterialsQuerySchema.safeParse({
    q: firstParam(raw.q),
    categoryId: firstParam(raw.categoryId),
    includeInactive: firstParam(raw.includeInactive),
    page: firstParam(raw.page),
    pageSize: firstParam(raw.pageSize),
  });
  const query = parsed.success ? parsed.data : listMaterialsQuerySchema.parse({});

  const db = await createSupabaseServerClient();
  const [materials, categories, suppliers] = await Promise.all([
    listMaterials(db, query),
    listCategories(db, { includeInactive: true }),
    listSuppliers(db, { includeInactive: true }),
  ]);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Materiały</h1>
      {materials.ok && categories.ok && suppliers.ok ? (
        <MaterialsView
          page={materials.data}
          categories={categories.data}
          suppliers={suppliers.data}
          canEdit={user.role === "ADMIN"}
          filters={{ q: query.q ?? "", categoryId: query.categoryId ?? "", includeInactive: query.includeInactive, pageSize: query.pageSize }}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać materiałów.
        </p>
      )}
    </div>
  );
}
