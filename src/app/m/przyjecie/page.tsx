import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listSuppliers } from "@/server/catalog";
import { getLocationByCode } from "@/server/locations";
import { listRecentMaterials } from "@/server/stock";
import { ReceiptWizard, type WizardLocation } from "./receipt-wizard";

export const metadata: Metadata = { title: "Przyjęcie — FOR-BUD Magazyn" };

// PRZYJĘCIE na terminalu: lokalizacja (skan/wpis albo ?lokalizacja=KOD z ekranu lokalizacji) → materiał →
// ilość → podsumowanie → ZATWIERDŹ. Dane słownikowe pobiera serwer; operację wykonuje POST /api/v1/stock/receipts.
export default async function ReceiptPage({ searchParams }: PageProps<"/m/przyjecie">) {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const raw = (await searchParams).lokalizacja;
  const code = Array.isArray(raw) ? raw[0] : raw;

  const db = await createSupabaseServerClient();
  const [suppliers, recent, preset] = await Promise.all([
    listSuppliers(db, { includeInactive: false }),
    listRecentMaterials(db, user.id, { type: "RECEIPT" }),
    code ? getLocationByCode(db, code) : Promise.resolve(null),
  ]);

  let initialLocation: WizardLocation | null = null;
  let initialMessage: string | null = null;
  if (preset) {
    if (!preset.ok) initialMessage = `Nieznany kod lokalizacji: ${code?.slice(0, 40)}. Zeskanuj lokalizację.`;
    else if (!preset.data.active) initialMessage = `Lokalizacja ${preset.data.code} jest nieaktywna. Wybierz inną.`;
    else initialLocation = { id: preset.data.id, code: preset.data.code, name: preset.data.name };
  }

  return (
    <ReceiptWizard
      userId={user.id}
      initialLocation={initialLocation}
      initialMessage={initialMessage}
      suppliers={suppliers.ok ? suppliers.data.map((s) => ({ id: s.id, name: s.name })) : []}
      recent={recent.ok ? recent.data : []}
    />
  );
}
