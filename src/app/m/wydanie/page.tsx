import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { getLocationByCode } from "@/server/locations";
import { listOrders, listRecentOrdersForUser } from "@/server/orders";
import { listRecentMaterials } from "@/server/stock";
import { IssueWizard } from "./issue-wizard";

export const metadata: Metadata = { title: "Wydanie — FOR-BUD Magazyn" };

// WYDANIE na terminalu (WAREHOUSE_WORKFLOW): na co (zlecenie / powód) → materiał → lokalizacja (lista miejsc,
// w których materiał jest, albo skan) → ilość → podsumowanie → ZATWIERDŹ. Z ekranu lokalizacji
// (?lokalizacja=KOD) lokalizacja jest ustalona, a materiał wybiera się z jej zawartości.
export default async function IssuePage({ searchParams }: PageProps<"/m/wydanie">) {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const raw = (await searchParams).lokalizacja;
  const code = Array.isArray(raw) ? raw[0] : raw;

  const db = await createSupabaseServerClient();
  const [recentOrders, openOrders, recentMaterials, preset] = await Promise.all([
    listRecentOrdersForUser(db, user.id),
    listOrders(db, { status: "ISSUABLE", page: 1, pageSize: 30 }),
    listRecentMaterials(db, user.id, { type: "ISSUE", inStockOnly: true }),
    code ? getLocationByCode(db, code) : Promise.resolve(null),
  ]);

  // Wydanie z nieaktywnej lokalizacji jest dozwolone (ADR 010) — lokalizację przyjmujemy niezależnie od statusu.
  const presetLocation = preset?.ok ? { id: preset.data.id, code: preset.data.code, name: preset.data.name } : null;
  const presetMessage = preset && !preset.ok ? `Nieznany kod lokalizacji: ${code?.slice(0, 40)}.` : null;

  return (
    <IssueWizard
      userId={user.id}
      presetLocation={presetLocation}
      presetMessage={presetMessage}
      recentOrders={recentOrders.ok ? recentOrders.data : []}
      openOrders={openOrders.ok ? openOrders.data.items : []}
      openOrdersTotal={openOrders.ok ? openOrders.data.total : 0}
      recentMaterials={recentMaterials.ok ? recentMaterials.data : []}
    />
  );
}
