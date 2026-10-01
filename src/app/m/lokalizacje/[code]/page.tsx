import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { decodeCodeParam } from "@/lib/validation/locations";
import { getLocationByCode } from "@/server/locations";
import { BackLink } from "../../back-link";

export const metadata: Metadata = { title: "Lokalizacja — FOR-BUD Magazyn" };

const BIG_BUTTON =
  "flex min-h-16 flex-col items-center justify-center rounded-2xl border text-xl font-bold";

export default async function MobileLocationPage({ params }: PageProps<"/m/lokalizacje/[code]">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  const rawCode = (await params).code;
  // Zepsute kodowanie procentowe → „Nieznany kod lokalizacji” (nie 500).
  const code = decodeCodeParam(rawCode) ?? rawCode;
  const result =
    decodeCodeParam(rawCode) === null
      ? ({ ok: false, error: { status: 404, code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" } } as const)
      : await getLocationByCode(await createSupabaseServerClient(), code);

  if (!result.ok) {
    const unknown = result.error.status === 404;
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header>
          <BackLink href="/m/skanuj">Skanuj</BackLink>
        </header>
        <div role="alert" className="flex flex-col gap-3 rounded-2xl bg-destructive/10 p-6 text-center">
          <p className="text-3xl font-bold text-destructive">
            {unknown ? "Nieznany kod lokalizacji" : "Nie udało się wczytać lokalizacji"}
          </p>
          {unknown && <p className="font-mono text-xl break-all">{code.trim().toUpperCase().slice(0, 60)}</p>}
        </div>
        <Link
          href="/m/skanuj"
          className="flex min-h-16 items-center justify-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground active:opacity-80"
        >
          Skanuj ponownie
        </Link>
      </div>
    );
  }

  const location = result.data;
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <BackLink href="/m/skanuj">Skanuj</BackLink>
        <Link href="/m/lokalizacje" className="inline-flex h-12 items-center px-3 text-lg underline underline-offset-4">
          Lista
        </Link>
      </header>

      {!location.active && (
        <p role="alert" className="rounded-xl bg-amber-100 p-4 text-lg font-semibold text-amber-900">
          Ta lokalizacja jest nieaktywna. Nie używaj jej do nowych operacji.
        </p>
      )}

      <section className="rounded-2xl border bg-background p-5 text-center">
        <h1 className="font-mono text-5xl leading-tight font-extrabold break-all">{location.code}</h1>
        {location.name && <p className="mt-2 text-xl">{location.name}</p>}
        {location.description && <p className="mt-2 text-base text-muted-foreground">{location.description}</p>}
        <p className="mt-3 text-sm font-medium">{location.active ? "Status: aktywna" : "Status: nieaktywna"}</p>
      </section>

      <section className="rounded-2xl border bg-background p-5">
        <h2 className="mb-2 text-lg font-semibold">Zawartość</h2>
        <p className="text-muted-foreground">Stany magazynowe pojawią się w kolejnym etapie.</p>
      </section>

      <div className="grid grid-cols-2 gap-4">
        <button type="button" disabled aria-disabled="true" className={`${BIG_BUTTON} bg-background opacity-60`}>
          PRZYJĘCIE
          <span className="text-xs font-medium text-muted-foreground">wkrótce</span>
        </button>
        <button type="button" disabled aria-disabled="true" className={`${BIG_BUTTON} bg-background opacity-60`}>
          WYDANIE
          <span className="text-xs font-medium text-muted-foreground">wkrótce</span>
        </button>
      </div>
    </div>
  );
}
