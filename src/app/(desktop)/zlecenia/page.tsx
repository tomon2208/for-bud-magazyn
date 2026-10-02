import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listOrdersQuerySchema } from "@/lib/validation/orders";
import { requirePageRole } from "@/server/auth";
import { listOrdersOverview } from "@/server/orders";
import { OrdersView } from "./orders-view";

export const metadata: Metadata = { title: "Zlecenia — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Lista zleceń (ADMIN, BIURO). Domyślnie: Otwarte + W produkcji (ISSUABLE); `?status=ALL` — wszystkie.
export default async function OrdersPage({ searchParams }: PageProps<"/zlecenia">) {
  await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const rawStatus = first(raw.status);
  const parsed = listOrdersQuerySchema.safeParse({
    status: rawStatus === "ALL" ? undefined : rawStatus,
    q: first(raw.q),
    page: first(raw.page),
    pageSize: 50,
  });
  const base = parsed.success ? parsed.data : listOrdersQuerySchema.parse({});
  const status = rawStatus === "ALL" ? undefined : (base.status ?? "ISSUABLE");
  const result = await listOrdersOverview(await createSupabaseServerClient(), { ...base, status });

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Zlecenia</h1>
      {result.ok ? (
        <OrdersView page={result.data} filters={{ status: rawStatus === "ALL" ? "ALL" : (status ?? "ISSUABLE"), q: base.q ?? "" }} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać zleceń.
        </p>
      )}
    </div>
  );
}
