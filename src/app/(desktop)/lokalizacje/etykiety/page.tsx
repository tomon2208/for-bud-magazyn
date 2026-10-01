import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { labelIdsSchema } from "@/lib/validation/locations";
import { requirePageRole } from "@/server/auth";
import { listLocationsByIds } from "@/server/locations";
import { LabelSheet } from "./label-sheet";

export const metadata: Metadata = { title: "Etykiety lokalizacji — FOR-BUD Magazyn" };

export default async function LabelsPage({ searchParams }: PageProps<"/lokalizacje/etykiety">) {
  await requirePageRole("ADMIN", "BIURO");
  const raw = (await searchParams).ids;
  const ids = labelIdsSchema.safeParse(Array.isArray(raw) ? raw[0] : (raw ?? ""));

  const result = ids.success ? await listLocationsByIds(await createSupabaseServerClient(), ids.data) : null;

  return (
    <div className="space-y-6 print:space-y-0">
      <div className="space-y-2 print:hidden">
        <h1 className="text-2xl font-semibold">Etykiety lokalizacji</h1>
        <Link href="/lokalizacje" className="text-sm underline underline-offset-4">
          ← Wróć do listy lokalizacji
        </Link>
      </div>
      {!result || !result.ok || result.data.length === 0 ? (
        <p role="alert" className="text-destructive print:hidden">
          {!ids.success
            ? "Nie wybrano lokalizacji (1–200). Zaznacz lokalizacje na liście i użyj „Drukuj etykiety”."
            : "Nie znaleziono wybranych lokalizacji."}
        </p>
      ) : (
        <LabelSheet locations={result.data.map((l) => ({ id: l.id, code: l.code, name: l.name }))} />
      )}
    </div>
  );
}
