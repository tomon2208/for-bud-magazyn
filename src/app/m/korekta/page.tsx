import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { getMaterial } from "@/server/catalog";
import { getLocationByCode } from "@/server/locations";
import { locationHref } from "../lokalizacje/href";
import { BackLink } from "../back-link";
import { MobileAdjustForm } from "./mobile-adjust-form";

export const metadata: Metadata = { title: "Korekta — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Terminal: korekta stanu materiału w lokalizacji (wyłącznie ADMIN — PRODUKCJA jest przekierowana na /m, API → 403).
// Wejście z ekranu lokalizacji: ?lokalizacja=KOD&material=ID.
export default async function MobileAdjustPage({ searchParams }: PageProps<"/m/korekta">) {
  await requirePageRole("ADMIN");
  const raw = await searchParams;
  const code = first(raw.lokalizacja) ?? "";
  const materialId = entityIdSchema.safeParse(first(raw.material));
  const db = await createSupabaseServerClient();
  const [location, material] = await Promise.all([
    code ? getLocationByCode(db, code) : Promise.resolve(null),
    materialId.success ? getMaterial(db, materialId.data) : Promise.resolve(null),
  ]);

  if (!location?.ok || !material?.ok) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header>
          <BackLink />
        </header>
        <p role="alert" className="rounded-2xl bg-destructive/10 p-6 text-center text-xl font-semibold text-destructive">
          Nie znaleziono materiału lub lokalizacji. Wejdź w korektę z ekranu lokalizacji.
        </p>
      </div>
    );
  }

  const l = location.data;
  const m = material.data;
  return (
    <MobileAdjustForm
      backHref={locationHref(l.code)}
      location={{ id: l.id, code: l.code, active: l.active }}
      material={{ id: m.id, code: m.code, name: m.name, unit: m.unit, allowsFraction: m.allowsFraction, active: m.active }}
    />
  );
}
