import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listStockQuerySchema } from "@/lib/validation/stock";
import { requirePageRole } from "@/server/auth";
import { listStock } from "@/server/stock";
import { StockView } from "./stock-view";

export const metadata: Metadata = { title: "Magazyn — FOR-BUD Magazyn" };

const PAGE_SIZE = 50;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Stany magazynowe (minimum do weryfikacji przyjęć; pełny dashboard w Etapie 7).
export default async function StockPage({ searchParams }: PageProps<"/magazyn">) {
  await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;
  const parsed = listStockQuerySchema.safeParse({
    q: firstParam(raw.q),
    page: firstParam(raw.page),
    pageSize: String(PAGE_SIZE),
  });
  const query = parsed.success ? parsed.data : listStockQuerySchema.parse({ pageSize: String(PAGE_SIZE) });
  const stock = await listStock(await createSupabaseServerClient(), query);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Magazyn — stany</h1>
      {stock.ok ? (
        <StockView page={stock.data} q={query.q ?? ""} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać stanów.
        </p>
      )}
    </div>
  );
}
