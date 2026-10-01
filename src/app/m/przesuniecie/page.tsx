import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { getLocationByCode } from "@/server/locations";
import { TransferWizard } from "./transfer-wizard";

export const metadata: Metadata = { title: "Przesunięcie — FOR-BUD Magazyn" };

// PRZESUNIĘCIE A → B na terminalu: skąd (skan albo ?z=KOD z ekranu lokalizacji) → materiał (zawartość
// lokalizacji) → ilość → dokąd (skan/wpis) → podsumowanie → ZATWIERDŹ. Źródłowa może być nieaktywna (ADR 010).
export default async function TransferPage({ searchParams }: PageProps<"/m/przesuniecie">) {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const raw = (await searchParams).z;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const preset = code ? await getLocationByCode(await createSupabaseServerClient(), code) : null;

  return (
    <TransferWizard
      userId={user.id}
      presetFrom={preset?.ok ? { id: preset.data.id, code: preset.data.code, name: preset.data.name } : null}
      presetMessage={preset && !preset.ok ? `Nieznany kod lokalizacji: ${code?.slice(0, 40)}. Zeskanuj lokalizację.` : null}
    />
  );
}
