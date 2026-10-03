import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listCategories } from "@/server/catalog";
import { ImportViewClient } from "./import-view-client";

export const metadata: Metadata = { title: "Nowe zlecenie z pliku — FOR-BUD Magazyn" };

// Nowe zlecenie z pliku LiczOkno (BIURO, ADMIN): zlecenie i lista zapotrzebowania powstają atomowo.
export default async function NewOrderFromFilePage() {
  const user = await requirePageRole("ADMIN", "BIURO");
  const categories = user.role === "ADMIN" ? await listCategories(await createSupabaseServerClient(), { includeInactive: false }) : null;

  return (
    <div className="max-w-7xl space-y-6">
      <div className="space-y-1">
        <Link href="/zlecenia" className="text-sm underline underline-offset-4">
          ← Zlecenia
        </Link>
        <h1 className="text-2xl font-semibold">Nowe zlecenie z pliku LiczOkno</h1>
      </div>
      <ImportViewClient
        mode={{ kind: "new" }}
        isAdmin={user.role === "ADMIN"}
        categories={categories?.ok ? categories.data.map((c) => ({ id: c.id, name: c.name })) : []}
      />
    </div>
  );
}
