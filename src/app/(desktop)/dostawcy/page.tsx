import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listSuppliers } from "@/server/catalog";
import { SuppliersAdmin } from "./suppliers-admin";

export const metadata: Metadata = { title: "Dostawcy — FOR-BUD Magazyn" };

export default async function SuppliersPage() {
  await requirePageRole("ADMIN", "BIURO");
  const result = await listSuppliers(await createSupabaseServerClient(), { includeInactive: true });

  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">Dostawcy</h1>
      {result.ok ? (
        <SuppliersAdmin suppliers={result.data} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać dostawców.
        </p>
      )}
    </div>
  );
}
