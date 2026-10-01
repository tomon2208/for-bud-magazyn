import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMovementsQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listSuppliers } from "@/server/catalog";
import { listMovements } from "@/server/stock";
import { ReceiptsView } from "./receipts-view";

export const metadata: Metadata = { title: "Przyjęcia — FOR-BUD Magazyn" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReceiptsPage({ searchParams }: PageProps<"/przyjecia">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const parsed = listMovementsQuerySchema.safeParse({
    type: "RECEIPT",
    q: firstParam(raw.q),
    from: firstParam(raw.from),
    to: firstParam(raw.to),
    page: firstParam(raw.page),
  });
  const query = parsed.success ? parsed.data : listMovementsQuerySchema.parse({ type: "RECEIPT" });

  const db = await createSupabaseServerClient();
  const isAdmin = user.role === "ADMIN";
  const [movements, suppliers] = await Promise.all([
    listMovements(db, query),
    isAdmin ? listSuppliers(db, { includeInactive: false }) : Promise.resolve(null),
  ]);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Przyjęcia</h1>
      {movements.ok ? (
        <ReceiptsView
          page={movements.data}
          filters={{ q: query.q ?? "", from: query.from ?? "", to: query.to ?? "" }}
          canReceive={isAdmin}
          suppliers={suppliers?.ok ? suppliers.data.map((s) => ({ id: s.id, name: s.name })) : []}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać przyjęć.
        </p>
      )}
    </div>
  );
}
