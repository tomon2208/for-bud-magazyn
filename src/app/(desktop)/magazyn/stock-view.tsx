"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import { formatQuantity } from "@/lib/validation/stock";
import type { StockPage } from "@/server/stock";

function buildUrl(q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/magazyn?${qs}` : "/magazyn";
}

export function StockView({ page, q: appliedQ }: { page: StockPage; q: string }) {
  const router = useRouter();
  const [q, setQ] = useState(appliedQ);

  useEffect(() => {
    if (q.trim() === appliedQ) return;
    const timer = setTimeout(() => router.replace(buildUrl(q.trim(), 1)), 300);
    return () => clearTimeout(timer);
  }, [q, appliedQ, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));

  return (
    <div className="space-y-4">
      <Input
        type="search"
        aria-label="Szukaj w stanach"
        placeholder="Kod/nazwa materiału lub kod lokalizacji"
        value={q}
        maxLength={MAX_SEARCH_LENGTH}
        onChange={(e) => setQ(e.target.value)}
        className="h-9 w-full sm:w-96"
      />

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {appliedQ ? "Brak stanów dla tej frazy." : "Magazyn jest pusty."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Materiał</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Lokalizacja</TableHead>
                <TableHead className="text-right">Ilość</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((r) => (
                <TableRow key={`${r.materialId}:${r.locationId}`}>
                  <TableCell className="font-mono">{r.materialCode}</TableCell>
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted-foreground">
          {page.total} poz. · strona {Math.min(page.page, totalPages)} z {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page <= 1}
            onClick={() => router.push(buildUrl(appliedQ, page.page - 1))}
          >
            Poprzednia
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page >= totalPages}
            onClick={() => router.push(buildUrl(appliedQ, page.page + 1))}
          >
            Następna
          </Button>
        </div>
      </div>
    </div>
  );
}
