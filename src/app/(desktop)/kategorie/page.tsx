import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listCategories } from "@/server/catalog";
import { CategoriesAdmin } from "./categories-admin";

export const metadata: Metadata = { title: "Kategorie — FOR-BUD Magazyn" };

export default async function CategoriesPage() {
  await requirePageRole("ADMIN");
  const result = await listCategories(await createSupabaseServerClient(), { includeInactive: true });

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Kategorie materiałów</h1>
      {result.ok ? (
        <CategoriesAdmin categories={result.data} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać kategorii.
        </p>
      )}
    </div>
  );
}
