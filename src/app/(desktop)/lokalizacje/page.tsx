import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listLocationsQuerySchema } from "@/lib/validation/locations";
import { requirePageRole } from "@/server/auth";
import { listLocations } from "@/server/locations";
import { LocationsView } from "./locations-view";

export const metadata: Metadata = { title: "Lokalizacje — FOR-BUD Magazyn" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LocationsPage({ searchParams }: PageProps<"/lokalizacje">) {
  const user = await requirePageRole("ADMIN", "BIURO");
  const raw = await searchParams;

  // Nieprawidłowe parametry w URL ignorujemy (wartości domyślne) zamiast pokazywać błąd.
  const parsed = listLocationsQuerySchema.safeParse({
    q: firstParam(raw.q),
    includeInactive: firstParam(raw.includeInactive),
    page: firstParam(raw.page),
    pageSize: firstParam(raw.pageSize),
  });
  const query = parsed.success ? parsed.data : listLocationsQuerySchema.parse({});

  const locations = await listLocations(await createSupabaseServerClient(), query);

  return (
    <div className="max-w-7xl space-y-6">
      <h1 className="text-2xl font-semibold">Lokalizacje</h1>
      {locations.ok ? (
        <LocationsView
          page={locations.data}
          canEdit={user.role === "ADMIN"}
          canPrint={user.role === "ADMIN" || user.role === "BIURO"}
          filters={{ q: query.q ?? "", includeInactive: query.includeInactive, pageSize: query.pageSize }}
        />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać lokalizacji.
        </p>
      )}
    </div>
  );
}
