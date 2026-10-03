"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { CsvButton } from "@/components/csv-button";
import { SELECT_CLASS } from "@/components/form-parts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pluralPl } from "@/lib/format";
import { formatSubstitutesInStock } from "@/lib/substitutes";
import { formatQuantity } from "@/lib/validation/stock";
import type { ShortageDto } from "@/server/requirements";

type Filters = { supplier: string; category: string; onlyShort: boolean };
type Option = { id: string; name: string };

function buildUrl(f: Filters) {
  const params = new URLSearchParams();
  if (f.supplier) params.set("dostawca", f.supplier);
  if (f.category) params.set("kategoria", f.category);
  if (!f.onlyShort) params.set("braki", "0");
  const qs = params.toString();
  return qs ? `/braki?${qs}` : "/braki";
}

function exportUrl(f: Filters) {
  const params = new URLSearchParams();
  if (f.supplier) params.set("supplier", f.supplier);
  if (f.category) params.set("category", f.category);
  if (f.onlyShort) params.set("onlyShort", "true");
  const qs = params.toString();
  return `/api/v1/shortages/export${qs ? `?${qs}` : ""}`;
}

export function ShortagesView({
  items,
  total,
  suppliers,
  categories,
  filters,
}: {
  items: ShortageDto[];
  total: number;
  suppliers: Option[];
  categories: Option[];
  filters: Filters;
}) {
  const router = useRouter();
  const [csvError, setCsvError] = useState<string | null>(null);

  // Grupy wg dostawcy (lista jest już posortowana: dostawca, największy brak; bez dostawcy na końcu).
  const groups: { key: string; name: string | null; rows: ShortageDto[] }[] = [];
  for (const row of items) {
    const key = row.supplierId ?? "none";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, name: row.supplierName, rows: [row] });
  }
  const shortCount = items.filter((i) => i.shortage > 0).length;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Suma „pozostało do wydania” po wszystkich zleceniach Otwarte i W produkcji, porównana ze stanem magazynu (aktywne lokalizacje, liczony
        raz na materiał). Rezerwacje nie są jeszcze uwzględniane.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Dostawca
          <select
            value={filters.supplier}
            onChange={(e) => router.replace(buildUrl({ ...filters, supplier: e.target.value }))}
            className={SELECT_CLASS}
          >
            <option value="">wszyscy</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Kategoria
          <select
            value={filters.category}
            onChange={(e) => router.replace(buildUrl({ ...filters, category: e.target.value }))}
            className={SELECT_CLASS}
          >
            <option value="">wszystkie</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.onlyShort}
            onChange={(e) => router.replace(buildUrl({ ...filters, onlyShort: e.target.checked }))}
            className="size-4"
          />
          Tylko z brakiem
        </label>
        <CsvButton url={exportUrl(filters)} label="Pobierz CSV" onError={setCsvError} fallbackName="braki.csv" />
      </div>
      {csvError && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {csvError}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filters.onlyShort ? "Brak materiałów z brakiem dla podanych filtrów." : "Brak zapotrzebowania dla podanych filtrów."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kod</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Kategoria</TableHead>
                <TableHead className="text-right">Pozostało do wydania</TableHead>
                <TableHead className="text-right">Dostępne</TableHead>
                <TableHead className="text-right">Brakuje</TableHead>
                <TableHead>Zlecenia</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={7} className="font-semibold">
                      Dostawca: {g.name ?? "brak dostawcy domyślnego"}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({g.rows.length} {pluralPl(g.rows.length, "materiał", "materiały", "materiałów")})
                      </span>
                    </TableCell>
                  </TableRow>
                  {g.rows.map((r) => (
                    <TableRow key={r.materialId} className={r.shortage > 0 ? "bg-destructive/5" : undefined}>
                      <TableCell className="font-mono">
                        <Link href={`/materialy/${r.materialId}`} className="underline underline-offset-4">
                          {r.materialCode}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {r.materialName}
                        {r.shortage > 0 && formatSubstitutesInStock(r.substitutes) && (
                          <div className="text-xs font-medium text-amber-800">odpowiedniki: {formatSubstitutesInStock(r.substitutes)}</div>
                        )}
                      </TableCell>
                      <TableCell>{r.categoryName}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {formatQuantity(r.remaining)} {r.unit}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {formatQuantity(r.available)} {r.unit}
                      </TableCell>
                      <TableCell className={`text-right font-semibold whitespace-nowrap ${r.shortage > 0 ? "text-destructive" : ""}`}>
                        {r.shortage > 0 ? `${formatQuantity(r.shortage)} ${r.unit}` : "—"}
                      </TableCell>
                      <TableCell className="max-w-sm text-sm">
                        {r.orders.map((o, i) => (
                          <span key={o.orderId}>
                            {i > 0 && ", "}
                            <Link href={`/zlecenia/${o.orderId}`} className="underline underline-offset-4">
                              {o.number ? `${o.number} ${o.name}` : o.name}
                            </Link>{" "}
                            <span className="text-muted-foreground">({formatQuantity(o.remaining)})</span>
                          </span>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {items.length} {pluralPl(items.length, "materiał", "materiały", "materiałów")}, z brakiem: {shortCount}.
        {total > items.length && ` Pokazano ${items.length} z ${total} — zawęź filtry.`}
      </p>
    </div>
  );
}
