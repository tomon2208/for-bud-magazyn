"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchStock, type StockRow } from "@/lib/stock-client";
import { formatQuantity } from "@/lib/validation/stock";
import { BIG_ROW, BIG_SECONDARY } from "./wizard-parts";

/** Wiersze stanu (materiał w lokalizacji) pobierane z API — duże przyciski z ilością. */
export function StockRows({
  filter,
  emptyText,
  show,
  onSelect,
}: {
  filter: { materialId?: string; locationId?: string };
  emptyText: string;
  /** Co pokazać jako główną etykietę wiersza: materiał (zawartość lokalizacji) albo lokalizację. */
  show: "material" | "location";
  onSelect: (row: StockRow) => void;
}) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ok"; items: StockRow[] } | { kind: "error"; message: string }>({
    kind: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const { materialId, locationId } = filter;

  useEffect(() => {
    let cancelled = false;
    void fetchStock({ materialId, locationId }).then((r) => {
      if (cancelled) return;
      setState(r.kind === "ok" ? { kind: "ok", items: r.items } : { kind: "error", message: r.message });
    });
    return () => {
      cancelled = true;
    };
  }, [materialId, locationId, attempt]);

  if (state.kind === "loading") return <p className="rounded-xl bg-muted p-4 text-lg">Wczytywanie stanów…</p>;
  if (state.kind === "error") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-xl bg-destructive/10 p-4 text-destructive">
        <p>{state.message}</p>
        <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => (setState({ kind: "loading" }), setAttempt((n) => n + 1))}>
          Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (state.items.length === 0) {
    return <p className="rounded-xl border bg-background p-4 text-center text-lg text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {state.items.map((r) => (
        <li key={`${r.materialId}-${r.locationId}`}>
          <button type="button" className={BIG_ROW} onClick={() => onSelect(r)}>
            <span className="flex w-full items-baseline justify-between gap-3">
              <span className="font-mono text-xl font-bold break-all">{show === "material" ? r.materialCode : r.locationCode}</span>
              <span className="shrink-0 text-xl font-bold whitespace-nowrap">
                {formatQuantity(r.quantity)} <span className="text-base font-medium">{r.unit}</span>
              </span>
            </span>
            <span className="text-base text-muted-foreground">
              {show === "material" ? r.materialName : (r.locationName ?? "")}
              {show === "location" && !r.locationActive ? " (nieaktywna)" : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

