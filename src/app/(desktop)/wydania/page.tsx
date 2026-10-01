import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMovementsQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getOrder } from "@/server/orders";
import { listMovements } from "@/server/stock";
import { IssuesView } from "./issues-view";

export const metadata: Metadata = { title: "Wydania — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Wydania i przesunięcia (zakładki ?typ=przesuniecia). ADMIN: formularze wydania i przesunięcia.
export default async function IssuesPage({ searchParams }: PageProps<"/wydania">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const tab = first(raw.typ) === "przesuniecia" ? "TRANSFER" : "ISSUE";
  const parsed = listMovementsQuerySchema.safeParse({
    type: tab,
    q: first(raw.q),
    from: first(raw.from),
    to: first(raw.to),
    orderId: tab === "ISSUE" ? first(raw.zlecenie) : undefined,
    page: first(raw.page),
  });
  const query = parsed.success ? parsed.data : listMovementsQuerySchema.parse({ type: tab });

  const db = await createSupabaseServerClient();
  const isAdmin = user.role === "ADMIN";
  const [movements, selectedOrder] = await Promise.all([
    // Przesunięcie = jeden wiersz (ruch przychodzący z kodami skąd/dokąd).
    listMovements(db, query, { collapseTransfers: true }),
    // Wybrane w filtrze zlecenie (nazwa + data/notatka); wybór — wyszukiwarką zleceń, bez listy wszystkich.
    query.orderId ? getOrder(db, query.orderId) : Promise.resolve(null),
  ]);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Wydania i przesunięcia</h1>
      {movements.ok ? (
        <IssuesView
          tab={tab}
          page={movements.data}
          filters={{ q: query.q ?? "", from: query.from ?? "", to: query.to ?? "", orderId: query.orderId ?? "" }}
          selectedOrder={selectedOrder?.ok ? selectedOrder.data : null}
          canOperate={isAdmin}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać operacji.
        </p>
      )}
    </div>
  );
}
