import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { ISSUABLE_STATUSES } from "@/lib/validation/orders";
import { requirePageRole } from "@/server/auth";
import { listCategories } from "@/server/catalog";
import { getOrder } from "@/server/orders";
import { listRequirements } from "@/server/requirements";
import { ImportViewClient } from "../../import/import-view-client";

export const metadata: Metadata = { title: "Import z LiczOkno — FOR-BUD Magazyn" };

// Import listy zapotrzebowania z pliku LiczOkno do istniejącego zlecenia (BIURO, ADMIN).
export default async function OrderImportPage({ params }: PageProps<"/zlecenia/[id]/import">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const id = entityIdSchema.safeParse((await params).id);
  if (!id.success) notFound();

  const db = await createSupabaseServerClient();
  const [order, requirements, categories] = await Promise.all([
    getOrder(db, id.data),
    listRequirements(db, id.data),
    user.role === "ADMIN" ? listCategories(db, { includeInactive: false }) : Promise.resolve(null),
  ]);
  if (!order.ok) {
    if (order.error.status === 404) notFound();
    return (
      <p role="alert" className="text-destructive">
        Nie udało się wczytać zlecenia.
      </p>
    );
  }
  const o = order.data;
  const issuable = (ISSUABLE_STATUSES as readonly string[]).includes(o.status);
  const activeFileNames = requirements.ok
    ? requirements.data.filter((r) => r.status === "ACTIVE" && r.source === "IMPORT" && r.importedFileName).map((r) => r.importedFileName as string)
    : [];

  return (
    <div className="max-w-7xl space-y-6">
      <div className="space-y-1">
        <Link href={`/zlecenia/${o.id}`} className="text-sm underline underline-offset-4">
          ← Zlecenie
        </Link>
        <h1 className="text-2xl font-semibold">Import z LiczOkno — {o.number ? `${o.number} · ` : ""}{o.name}</h1>
      </div>
      {issuable ? (
        <ImportViewClient
          mode={{ kind: "existing", orderId: o.id, orderName: o.number ? `${o.number} · ${o.name}` : o.name, activeFileNames }}
          isAdmin={user.role === "ADMIN"}
          categories={categories?.ok ? categories.data.map((c) => ({ id: c.id, name: c.name })) : []}
        />
      ) : (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby zaimportować listę.
        </p>
      )}
    </div>
  );
}
