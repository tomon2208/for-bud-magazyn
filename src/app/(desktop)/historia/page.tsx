import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeLocationCode } from "@/lib/validation/locations";
import { historyQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { getMaterial } from "@/server/catalog";
import { getLocationByCode } from "@/server/locations";
import { getOrder } from "@/server/orders";
import { listMovements, listUserNames } from "@/server/stock";
import { HistoryView, type HistoryFilters } from "./history-view";

export const metadata: Metadata = { title: "Historia ruchów — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Id, które na pewno nic nie znajdzie (nieznany kod lokalizacji w filtrze). */
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

// Historia ruchów (ADMIN, BIURO): wszystkie typy operacji, filtry w URL, filtrowanie i paginacja w SQL.
// ADMIN: „Cofnij” (storno) i kontrola spójności stanów (verify_stock).
export default async function HistoryPage({ searchParams }: PageProps<"/historia">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const locationCode = normalizeLocationCode(first(raw.lokalizacja) ?? "");
  const parsed = historyQuerySchema.safeParse({
    type: first(raw.typ),
    q: first(raw.q),
    materialId: first(raw.material),
    userId: first(raw.uzytkownik),
    orderId: first(raw.zlecenie),
    operationId: first(raw.operacja),
    from: first(raw.from),
    to: first(raw.to),
    page: first(raw.page),
  });
  const query = parsed.success ? parsed.data : historyQuerySchema.parse({});

  const db = await createSupabaseServerClient();
  const location = locationCode ? await getLocationByCode(db, locationCode) : null;
  const locationId = location ? (location.ok ? location.data.id : NO_MATCH) : undefined;

  const [movements, users, order, material] = await Promise.all([
    listMovements(db, { ...query, locationId }, { collapseTransfers: true }),
    listUserNames(db),
    query.orderId ? getOrder(db, query.orderId) : Promise.resolve(null),
    query.materialId ? getMaterial(db, query.materialId) : Promise.resolve(null),
  ]);

  const filters: HistoryFilters = {
    type: query.type ?? "",
    q: query.q ?? "",
    materialId: query.materialId ?? "",
    location: locationCode,
    userId: query.userId ?? "",
    orderId: query.orderId ?? "",
    operationId: query.operationId ?? "",
    from: query.from ?? "",
    to: query.to ?? "",
  };

  return (
    <div className="max-w-[90rem] space-y-6">
      <h1 className="text-2xl font-semibold">Historia ruchów</h1>
      {!parsed.success && (
        <p role="alert" className="text-sm text-destructive">
          Nieprawidłowe filtry w adresie — pokazano całą historię.
        </p>
      )}
      {movements.ok ? (
        <HistoryView
          page={movements.data}
          filters={filters}
          users={users.ok ? users.data : []}
          selectedOrder={order?.ok ? order.data : null}
          selectedMaterial={material?.ok ? { code: material.data.code, name: material.data.name } : null}
          unknownLocation={location !== null && !location.ok}
          isAdmin={user.role === "ADMIN"}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać historii.
        </p>
      )}
    </div>
  );
}
