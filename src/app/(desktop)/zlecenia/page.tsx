import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listOrdersQuerySchema } from "@/lib/validation/orders";
import { requirePageRole } from "@/server/auth";
import { listOrders } from "@/server/orders";
import { OrdersView } from "./orders-view";

export const metadata: Metadata = { title: "Zlecenia — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OrdersPage({ searchParams }: PageProps<"/zlecenia">) {
  await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const parsed = listOrdersQuerySchema.safeParse({
    status: first(raw.status),
    q: first(raw.q),
    page: first(raw.page),
    pageSize: 50,
  });
  const query = parsed.success ? parsed.data : listOrdersQuerySchema.parse({});
  const result = await listOrders(await createSupabaseServerClient(), query);

  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">Zlecenia</h1>
      {result.ok ? (
        <OrdersView page={result.data} filters={{ status: query.status ?? "", q: query.q ?? "" }} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać zleceń.
        </p>
      )}
    </div>
  );
}
