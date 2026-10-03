import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requirePageRole } from "@/server/auth";
import { getSessionEvents, getSessionOverview, getSessionReview } from "@/server/inventory";
import { SessionView } from "./session-view";

export const metadata: Metadata = { title: "Sesja inwentaryzacji — FOR-BUD Magazyn" };

// Szczegóły sesji (BIURO, ADMIN): postęp, tabela pozycji ze stanem systemowym (TERAZ), policzoną ilością, różnicą
// i statusem; zatwierdzanie całości / zaznaczonych, zamknięcie, anulowanie, CSV, historia liczeń (ADR 015).
export default async function InventorySessionPage({ params }: PageProps<"/inwentaryzacja/[id]">) {
  await requirePageRole("ADMIN", "BIURO");
  const { id } = await params;
  const valid = entityIdSchema.safeParse(id);
  if (!valid.success) {
    return <p role="alert" className="text-destructive">Nieprawidłowy identyfikator sesji.</p>;
  }
  const db = await createSupabaseServerClient();
  const [overview, rows, events] = await Promise.all([
    getSessionOverview(db, valid.data),
    getSessionReview(db, valid.data),
    getSessionEvents(db, valid.data),
  ]);

  return (
    <div className="max-w-7xl space-y-6">
      <Link href="/inwentaryzacja" className="text-sm underline underline-offset-4">
        ← Wszystkie sesje
      </Link>
      {!overview.ok || !rows.ok || !events.ok ? (
        <p role="alert" className="text-destructive">
          {!overview.ok && overview.error.code === "NOT_FOUND" ? "Nie znaleziono sesji inwentaryzacji." : "Nie udało się wczytać sesji."}
        </p>
      ) : (
        <SessionView
          key={`${overview.data.session.id}-${overview.data.session.status}`}
          overview={overview.data}
          rows={rows.data}
          events={events.data}
        />
      )}
    </div>
  );
}
