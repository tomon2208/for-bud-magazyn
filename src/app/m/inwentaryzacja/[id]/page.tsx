import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { getSessionOverview } from "@/server/inventory";
import { BackLink } from "../../back-link";
import { CountWizard } from "./count-wizard";

export const metadata: Metadata = { title: "Liczenie — FOR-BUD Magazyn" };

// Liczenie sesji na terminalu: skan lokalizacji (musi należeć do sesji) → materiały oczekiwane BEZ ilości + „Dodaj
// inny materiał” → policzone ilości → ZAPISZ LOKALIZACJĘ. Dane sesji bez stanów systemowych (overview).
export default async function MobileCountPage({ params }: PageProps<"/m/inwentaryzacja/[id]">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const { id } = await params;
  const valid = entityIdSchema.safeParse(id);
  const overview = valid.success ? await getSessionOverview(await createSupabaseServerClient(), valid.data) : null;

  if (!overview?.ok || overview.data.session.status !== "OPEN") {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header className="flex items-center justify-between">
          <BackLink href="/m/inwentaryzacja">Sesje</BackLink>
          <h1 className="pr-3 text-xl font-bold">Inwentaryzacja</h1>
        </header>
        <p role="alert" className="rounded-2xl bg-amber-100 p-5 text-lg text-amber-950">
          {overview?.ok ? "Ta sesja inwentaryzacji jest już zamknięta." : "Nie znaleziono sesji inwentaryzacji."}
        </p>
      </div>
    );
  }

  return <CountWizard session={{ id: overview.data.session.id, name: overview.data.session.name }} locations={overview.data.locations} />;
}
