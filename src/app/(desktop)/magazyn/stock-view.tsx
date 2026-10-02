"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SELECT_CLASS } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import { formatQuantity } from "@/lib/validation/stock";
import type { CategoryDto } from "@/server/catalog";
import type { MaterialTotalPage } from "@/server/overview";
import type { StockPage } from "@/server/stock";

export type StockFilters = { mode: "lokalizacje" | "materialy"; q: string; categoryId: string; belowMin: boolean };

function buildUrl(f: StockFilters, page: number) {
  const params = new URLSearchParams();
  if (f.mode === "materialy") params.set("widok", "materialy");
  if (f.q) params.set("q", f.q);
  if (f.categoryId) params.set("kategoria", f.categoryId);
  if (f.belowMin) params.set("ponizej", "1");
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/magazyn?${qs}` : "/magazyn";
}

/** Adres eksportu CSV z bieżącymi filtrami widoku (serwer generuje plik). */
function exportUrl(variant: "location" | "material", f: StockFilters) {
  const params = new URLSearchParams({ variant });
  if (f.q) params.set("q", f.q);
  if (f.categoryId) params.set("categoryId", f.categoryId);
  if (f.belowMin) params.set("belowMin", "true");
  return `/api/v1/stock/export?${params.toString()}`;
}

export function StockView({
  filters,
  categories,
  canAdjust,
  locations,
  totals,
}: {
  filters: StockFilters;
  categories: CategoryDto[];
  canAdjust: boolean;
  locations: StockPage | null;
  totals: MaterialTotalPage | null;
}) {
  const router = useRouter();
  const [csvError, setCsvError] = useState<string | null>(null);
  // Pole zawsze odzwierciedla URL: zmiana filtra z zewnątrz (menu, Wstecz) resetuje pole, a własne wysłane
  // wartości (sentQ) nie nadpisują tego, co użytkownik właśnie dopisał (jak w widoku Materiały).
  const [q, setQ] = useState(filters.q);
  const [sentQ, setSentQ] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  const { q: appliedQ, mode } = filters;
  if (appliedQ !== seenQ) {
    setSeenQ(appliedQ);
    if (appliedQ !== sentQ) {
      setQ(appliedQ);
      setSentQ(appliedQ);
    }
  }
  const page = (mode === "materialy" ? totals : locations) ?? { total: 0, page: 1, pageSize: 50 };

  useEffect(() => {
    if (q.trim() === appliedQ) return;
    const timer = setTimeout(() => {
      setSentQ(q.trim());
      router.replace(buildUrl({ ...filters, q: q.trim() }, 1));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, appliedQ, filters, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const current = Math.min(page.page, totalPages);
  const filtered = appliedQ !== "" || filters.categoryId !== "" || filters.belowMin;
  const tab = (target: StockFilters["mode"], label: string) => (
    <Link
      href={buildUrl({ ...filters, mode: target }, 1)}
      aria-current={mode === target ? "page" : undefined}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-sm font-medium",
        mode === target ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {tab("lokalizacje", "Per lokalizacja")}
        {tab("materialy", "Suma per materiał")}
        <span className="mx-2 hidden h-6 border-l sm:block" aria-hidden="true" />
        <CsvButton url={exportUrl("location", filters)} label="Pobierz CSV (per lokalizacja)" onError={setCsvError} />
        <CsvButton url={exportUrl("material", filters)} label="Pobierz CSV (suma per materiał)" onError={setCsvError} />
      </div>
      {csvError && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {csvError}
        </p>
      )}
      {canAdjust && (
        <div className="flex flex-wrap gap-4 text-sm">
          <Link href="/magazyn/korekta" className="underline underline-offset-4">
            Korekta stanu (także materiał w nowej lokalizacji)
          </Link>
          <Link href="/historia" className="underline underline-offset-4">
            Historia ruchów i kontrola spójności
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="search"
          aria-label="Szukaj w stanach"
          placeholder={mode === "materialy" ? "Kod lub nazwa materiału" : "Kod/nazwa materiału lub kod lokalizacji"}
          value={q}
          maxLength={MAX_SEARCH_LENGTH}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-full sm:w-96"
        />
        <select
          aria-label="Filtr kategorii"
          value={filters.categoryId}
          onChange={(e) => router.replace(buildUrl({ ...filters, q: q.trim(), categoryId: e.target.value }, 1))}
          className={SELECT_CLASS}
        >
          <option value="">Wszystkie kategorie</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.active ? "" : " (nieaktywna)"}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.belowMin}
            onChange={(e) => router.replace(buildUrl({ ...filters, q: q.trim(), belowMin: e.target.checked }, 1))}
          />
          Tylko poniżej minimum
        </label>
      </div>

      {page.total === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filtered ? "Brak wyników dla podanych filtrów." : "Magazyn jest pusty."}
        </p>
      ) : mode === "lokalizacje" && locations ? (
        <LocationsTable page={locations} canAdjust={canAdjust} />
      ) : totals ? (
        <TotalsTable page={totals} />
      ) : null}

      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted-foreground">
          {page.total} poz. · strona {current} z {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page <= 1}
            onClick={() => router.push(buildUrl(filters, page.page - 1))}
          >
            Poprzednia
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page >= totalPages}
            onClick={() => router.push(buildUrl(filters, page.page + 1))}
          >
            Następna
          </Button>
        </div>
      </div>
    </div>
  );
}

function LocationsTable({ page, canAdjust }: { page: StockPage; canAdjust: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Materiał</TableHead>
            <TableHead>Nazwa</TableHead>
            <TableHead>Lokalizacja</TableHead>
            <TableHead className="text-right">Ilość</TableHead>
            {canAdjust && <TableHead className="w-24" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.items.map((r) => (
            <TableRow key={`${r.materialId}:${r.locationId}`}>
              <TableCell className="font-mono">
                <Link href={`/materialy/${r.materialId}`} className="underline underline-offset-4">
                  {r.materialCode}
                </Link>
              </TableCell>
              <TableCell>
                {r.materialName}
                {!r.materialActive && <span className="ml-1 text-xs text-destructive">(nieaktywny)</span>}
              </TableCell>
              <TableCell className="font-mono">
                {r.locationCode}
                {!r.locationActive && <span className="ml-1 font-sans text-xs text-destructive">(nieaktywna)</span>}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <span className="font-semibold">{formatQuantity(r.quantity)}</span> {r.unit}
              </TableCell>
              {canAdjust && (
                <TableCell className="text-right">
                  <Link
                    href={`/magazyn/korekta?material=${r.materialId}&lokalizacja=${r.locationId}`}
                    className="text-sm underline underline-offset-4"
                    aria-label={`Koryguj stan ${r.materialCode} w ${r.locationCode}`}
                  >
                    Koryguj
                  </Link>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TotalsTable({ page }: { page: MaterialTotalPage }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Materiał</TableHead>
            <TableHead>Nazwa</TableHead>
            <TableHead>Kategoria</TableHead>
            <TableHead className="text-right">Stan łączny</TableHead>
            <TableHead className="text-right">Minimum</TableHead>
            <TableHead className="text-right">Lokalizacje</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.items.map((m) => (
            <TableRow key={m.materialId}>
              <TableCell className="font-mono">
                <Link href={`/materialy/${m.materialId}`} className="underline underline-offset-4">
                  {m.code}
                </Link>
              </TableCell>
              <TableCell>
                {m.name}
                {!m.active && <span className="ml-1 text-xs text-destructive">(nieaktywny)</span>}
              </TableCell>
              <TableCell>{m.categoryName}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <span className="font-semibold">{formatQuantity(m.totalQuantity)}</span> {m.unit}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {m.minQuantity === null ? "—" : `${formatQuantity(m.minQuantity)} ${m.unit}`}
              </TableCell>
              <TableCell className="text-right">{m.locationCount}</TableCell>
              <TableCell>
                {m.belowMinimum ? (
                  <Badge variant="destructive">poniżej minimum (brakuje {formatQuantity(m.shortage)})</Badge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * „Pobierz CSV”: fetch + blob, żeby błąd (401 po wygaśnięciu sesji, 403, 400 „zawęź filtry”, 500) pokazać
 * w UI zamiast zapisywać plik JSON. Nazwa pliku z Content-Disposition.
 */
function CsvButton({ url, label, onError }: { url: string; label: string; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        let message =
          res.status === 401
            ? "Sesja wygasła — zaloguj się ponownie."
            : res.status === 403
              ? "Brak uprawnień do eksportu."
              : "Nie udało się pobrać pliku. Spróbuj ponownie.";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (res.status === 400 && body.error?.message) message = body.error.message;
        } catch {
          // nieczytelne ciało błędu — zostaje komunikat domyślny
        }
        onError(message);
        return;
      }
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = match?.[1] ?? "stany.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      onError("Brak połączenia. Spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={busy} onClick={() => void download()}>
      {busy ? "Pobieranie…" : label}
    </Button>
  );
}
