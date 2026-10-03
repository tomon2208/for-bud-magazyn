import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listImportAliases } from "@/server/import";
import { AliasesView } from "./aliases-view";

export const metadata: Metadata = { title: "Powiązania LiczOkno — FOR-BUD Magazyn" };

// Powiązania kodów z plików LiczOkno z materiałami i lista „nie magazynujemy” (BIURO, ADMIN).
export default async function ImportAliasesPage() {
  await requirePageRole("ADMIN", "BIURO");
  const result = await listImportAliases(await createSupabaseServerClient());

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-1">
        <Link href="/materialy" className="text-sm underline underline-offset-4">
          ← Materiały
        </Link>
        <h1 className="text-2xl font-semibold">Powiązania kodów LiczOkno</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Kody z plików LiczOkno, które nie są kodami materiałów w kartotece: powiązane z materiałem (import dopasuje je
          automatycznie) albo oznaczone jako „nie magazynujemy” (import je pomija). Usunięcie wpisu przywraca zwykłe
          dopasowanie po kodzie.
        </p>
      </div>
      {result.ok ? (
        <AliasesView items={result.data.items} total={result.data.total} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać powiązań.
        </p>
      )}
    </div>
  );
}
