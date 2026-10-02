import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { getMaterial } from "@/server/catalog";
import { getLocation } from "@/server/locations";
import { AdjustmentForm, type AdjustLocation } from "./adjustment-form";
import type { PickedMaterial } from "@/components/material-picker";

export const metadata: Metadata = { title: "Korekta stanu — FOR-BUD Magazyn" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// Korekta stanu (wyłącznie ADMIN): „ustaw stan na X” z powodem. Wejście z „Magazynu” (?material=&lokalizacja=)
// albo wybór materiału i lokalizacji na stronie (także miejsce, gdzie materiału jeszcze nie ma: 0 → X).
export default async function AdjustmentPage({ searchParams }: PageProps<"/magazyn/korekta">) {
  await requirePageRole("ADMIN");
  const raw = await searchParams;
  const materialId = entityIdSchema.safeParse(first(raw.material));
  const locationId = entityIdSchema.safeParse(first(raw.lokalizacja));
  const db = await createSupabaseServerClient();
  const [material, location] = await Promise.all([
    materialId.success ? getMaterial(db, materialId.data) : Promise.resolve(null),
    locationId.success ? getLocation(db, locationId.data) : Promise.resolve(null),
  ]);

  const initialMaterial: PickedMaterial | null =
    material?.ok
      ? {
          id: material.data.id,
          code: material.data.code,
          name: material.data.name,
          unit: material.data.unit,
          allowsFraction: material.data.allowsFraction,
          defaultSupplierId: material.data.defaultSupplierId,
          active: material.data.active,
        }
      : null;
  const initialLocation: AdjustLocation | null = location?.ok
    ? { id: location.data.id, code: location.data.code, active: location.data.active }
    : null;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link href="/magazyn" className="text-sm underline underline-offset-4">
          ← Magazyn
        </Link>
        <h1 className="text-2xl font-semibold">Korekta stanu</h1>
        <p className="text-sm text-muted-foreground">
          Wpisz faktyczną ilość w lokalizacji — system zapisze różnicę jako korektę z powodem (historia ruchów). Błędną
          operację lepiej cofnąć w „Historii ruchów”.
        </p>
      </div>
      <AdjustmentForm initialMaterial={initialMaterial} initialLocation={initialLocation} />
    </div>
  );
}
