import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listInventorySessions } from "@/server/inventory";
import { BackLink } from "../back-link";

export const metadata: Metadata = { title: "Inwentaryzacja — FOR-BUD Magazyn" };

const DATE = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "numeric", year: "numeric", timeZone: "Europe/Warsaw" });

// INWENTARYZACJA na terminalu (PRODUKCJA, ADMIN): wybór otwartej sesji → liczenie lokalizacji (ADR 015).
export default async function MobileInventoryPage() {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const sessions = await listInventorySessions(await createSupabaseServerClient(), "OPEN");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <BackLink />
        <h1 className="pr-3 text-xl font-bold">Inwentaryzacja</h1>
      </header>

      {!sessions.ok ? (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-lg text-destructive">
          Nie udało się wczytać sesji inwentaryzacji.
        </p>
      ) : sessions.data.length === 0 ? (
        <p className="rounded-2xl border bg-background p-5 text-lg">
          Brak otwartej inwentaryzacji. Sesję zakłada biuro — wróć, gdy zostanie otwarta.
        </p>
      ) : (
        <>
          <h2 className="text-2xl font-bold">Wybierz sesję</h2>
          <ul className="flex flex-col gap-3">
            {sessions.data.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/m/inwentaryzacja/${s.id}`}
                  className="flex min-h-20 w-full flex-col justify-center gap-1 rounded-2xl border bg-background px-4 py-3 active:bg-muted"
                >
                  <span className="text-xl font-bold break-words">{s.name}</span>
                  <span className="text-base text-muted-foreground">
                    Policzone lokalizacje: {s.countedLocationCount} z {s.locationCount} · od {DATE.format(new Date(s.createdAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
