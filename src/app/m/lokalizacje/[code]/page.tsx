import type { Metadata } from "next";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { decodeCodeParam } from "@/lib/validation/locations";
import { getLocationByCode } from "@/server/locations";
import { listStock } from "@/server/stock";
import { formatQuantity } from "@/lib/validation/stock";
import { BackLink } from "../../back-link";

export const metadata: Metadata = { title: "Lokalizacja — FOR-BUD Magazyn" };

const BIG_BUTTON =
  "flex min-h-16 flex-col items-center justify-center rounded-2xl border text-xl font-bold";

export default async function MobileLocationPage({ params }: PageProps<"/m/lokalizacje/[code]">) {
  const user = await requirePageRole("PRODUKCJA", "ADMIN");
  const canAdjust = user.role === "ADMIN";
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
  const contents = await listStock(await createSupabaseServerClient(), {
    locationId: location.id,
    page: 1,
    pageSize: 500,
  });
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
        {!contents.ok ? (
          <p role="alert" className="text-destructive">
            Nie udało się wczytać stanów.
          </p>
        ) : contents.data.items.length === 0 ? (
          <p className="text-muted-foreground">Lokalizacja jest pusta.</p>
        ) : (
          <ul className="divide-y">
            {contents.data.items.map((row) => (
              <li key={row.materialId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-mono text-lg font-bold break-all">{row.materialCode}</div>
                  <div className="text-sm text-muted-foreground">{row.materialName}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="text-right text-xl font-bold whitespace-nowrap">
                    {formatQuantity(row.quantity)} <span className="text-base font-medium">{row.unit}</span>
                  </div>
                  {/* Korekta stanu — wyłącznie ADMIN (API też odrzuca inne role). */}
                  {canAdjust && (
                    <Link
                      href={`/m/korekta?lokalizacja=${encodeURIComponent(location.code)}&material=${row.materialId}`}
                      className="inline-flex h-12 items-center rounded-xl border px-4 text-base font-semibold active:bg-muted"
                    >
                      Koryguj
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-4">
        {location.active ? (
          <Link
            href={`/m/przyjecie?lokalizacja=${encodeURIComponent(location.code)}`}
            className={`${BIG_BUTTON} bg-primary text-primary-foreground active:opacity-80`}
          >
            PRZYJĘCIE
          </Link>
        ) : (
          <button type="button" disabled aria-disabled="true" className={`${BIG_BUTTON} bg-background opacity-60`}>
            PRZYJĘCIE
            <span className="text-xs font-medium text-muted-foreground">nieaktywna</span>
          </button>
        )}
        {/* Wydanie i przesunięcie z nieaktywnej lokalizacji są dozwolone (opróżnienie miejsca) — ADR 010. */}
        <Link
          href={`/m/wydanie?lokalizacja=${encodeURIComponent(location.code)}`}
          className={`${BIG_BUTTON} bg-primary text-primary-foreground active:opacity-80`}
        >
          WYDANIE
        </Link>
      </div>
      <Link
        href={`/m/przesuniecie?z=${encodeURIComponent(location.code)}`}
        className="flex min-h-14 items-center justify-center rounded-2xl border bg-background text-lg font-semibold active:bg-muted"
      >
        Przesuń do innej lokalizacji
      </Link>
    </div>
  );
}
