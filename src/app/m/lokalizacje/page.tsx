import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listLocationsQuerySchema } from "@/lib/validation/locations";
import { requirePageRole } from "@/server/auth";
import { listLocations } from "@/server/locations";
import { BackLink } from "../back-link";
import { LocationSearch } from "./location-search";
import { locationHref } from "./href";

export const metadata: Metadata = { title: "Lokalizacje — FOR-BUD Magazyn" };

const LIMIT = 100;

export default async function MobileLocationsPage({ searchParams }: PageProps<"/m/lokalizacje">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const raw = (await searchParams).q;
  const parsed = listLocationsQuerySchema.safeParse({ q: Array.isArray(raw) ? raw[0] : raw, pageSize: String(LIMIT) });
  const query = parsed.success ? parsed.data : listLocationsQuerySchema.parse({ pageSize: String(LIMIT) });

  const result = await listLocations(await createSupabaseServerClient(), query);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <BackLink />
        <h1 className="pr-3 text-xl font-bold">Lokalizacje</h1>
      </header>

      <LocationSearch initial={query.q ?? ""} />

      {!result.ok ? (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-destructive">
          Nie udało się wczytać lokalizacji.
        </p>
      ) : result.data.items.length === 0 ? (
        <p className="rounded-xl border bg-background p-6 text-center text-lg text-muted-foreground">
          {query.q ? "Brak lokalizacji dla tej frazy." : "Brak lokalizacji."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {result.data.items.map((l) => (
              <li key={l.id}>
                <Link
                  href={locationHref(l.code)}
                  className="flex min-h-16 flex-col justify-center rounded-xl border bg-background px-4 py-2 active:bg-muted"
                >
                  <span className="font-mono text-2xl font-bold break-all">{l.code}</span>
                  {l.name && <span className="text-base text-muted-foreground">{l.name}</span>}
                </Link>
              </li>
            ))}
          </ul>
          {result.data.total > result.data.items.length && (
            <p className="text-center text-muted-foreground">
              Pokazano {result.data.items.length} z {result.data.total}. Zawęź wyszukiwanie.
            </p>
          )}
        </>
      )}
    </div>
  );
}
