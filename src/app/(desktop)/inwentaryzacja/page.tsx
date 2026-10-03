import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SESSION_STATUS_LABELS } from "@/lib/validation/inventory";
import { requirePageRole } from "@/server/auth";
import { listInventorySessions } from "@/server/inventory";
import { CreateSessionForm } from "./create-session-form";

export const metadata: Metadata = { title: "Inwentaryzacja — FOR-BUD Magazyn" };

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const STATUS_CLASS: Record<string, string> = {
  OPEN: "bg-teal-100 text-teal-900",
  CLOSED: "bg-muted",
  CANCELLED: "bg-rose-100 text-rose-900",
};

// Inwentaryzacja (BIURO, ADMIN — ADR 015): lista sesji z postępem i tworzenie nowej sesji (wybór lokalizacji:
// wszystkie aktywne / prefiks kodu / zaznaczenie). Liczy PRODUKCJA na terminalu, zatwierdza BIURO/ADMIN w szczegółach.
export default async function InventoryPage() {
  await requirePageRole("ADMIN", "BIURO");
  const db = await createSupabaseServerClient();
  const [sessions, locations, busy] = await Promise.all([
    listInventorySessions(db),
    db.from("locations").select("id, code, name").eq("active", true).order("code").limit(5000),
    db.from("inventory_session_locations").select("location_id").eq("is_open", true).limit(5000),
  ]);

  return (
    <div className="max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold">Inwentaryzacja</h1>

      {!sessions.ok ? (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać sesji inwentaryzacji.
        </p>
      ) : sessions.data.length === 0 ? (
        <p className="text-muted-foreground">Nie ma jeszcze żadnej sesji inwentaryzacji.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Nazwa</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Policzone lokalizacje</th>
                <th className="px-3 py-2 font-medium">Utworzona</th>
                <th className="px-3 py-2 font-medium">Zakończona</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2">
                    <Link href={`/inwentaryzacja/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                      {s.name}
                    </Link>
                    {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[s.status] ?? ""}`}>
                      {SESSION_STATUS_LABELS[s.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {s.countedLocationCount} / {s.locationCount}
                  </td>
                  <td className="px-3 py-2">
                    {DATE.format(new Date(s.createdAt))}
                    <div className="text-xs text-muted-foreground">{s.createdByName}</div>
                  </td>
                  <td className="px-3 py-2">
                    {s.closedAt ? DATE.format(new Date(s.closedAt)) : s.cancelledAt ? DATE.format(new Date(s.cancelledAt)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {locations.error || busy.error ? (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać lokalizacji.
        </p>
      ) : (
        <CreateSessionForm
          locations={(locations.data ?? []).map((l) => ({ id: l.id as string, code: l.code as string, name: (l.name as string | null) ?? null }))}
          busyLocationIds={(busy.data ?? []).map((b) => b.location_id as string)}
        />
      )}
    </div>
  );
}
