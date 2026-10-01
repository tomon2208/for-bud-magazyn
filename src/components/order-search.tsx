"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import { ORDER_STATUS_LABELS, orderSubLabel, type OrderStatus } from "@/lib/validation/orders";
import type { OrderDto } from "@/server/orders";

type State =
  | { kind: "loading" }
  | { kind: "ok"; items: OrderDto[]; total: number }
  | { kind: "error"; message: string };

const PAGE_SIZE = 15;

/**
 * Wyszukiwarka zleceń dla desktopu (GET /api/v1/orders?status=&q=). Bez frazy — najnowsze. Nazwy mogą się
 * powtarzać, więc każdy wiersz ma datę i godzinę utworzenia oraz notatkę.
 */
export function OrderSearch({
  status,
  onSelect,
  label = "Szukaj zlecenia",
}: {
  status?: OrderStatus;
  onSelect: (o: OrderDto) => void;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<State>({ kind: "loading" });
  const term = q.trim();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (status) params.set("status", status);
        if (term) params.set("q", term);
        const res = await fetch(`/api/v1/orders?${params}`, { signal: controller.signal });
        const json = (await res.json().catch(() => null)) as {
          data?: { items: OrderDto[]; total: number };
          error?: { message?: string };
        } | null;
        if (!res.ok || !json?.data) {
          setState({ kind: "error", message: json?.error?.message ?? `Błąd (${res.status})` });
          return;
        }
        setState({ kind: "ok", items: json.data.items, total: json.data.total });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setState({ kind: "error", message: "Brak połączenia z serwerem" });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, status]);

  return (
    <div className="space-y-2">
      <Input
        type="search"
        aria-label={label}
        placeholder="Nazwa zlecenia (np. nazwisko)"
        value={q}
        maxLength={MAX_SEARCH_LENGTH}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        className="h-9"
      />
      {state.kind === "loading" && <p className="text-sm text-muted-foreground">Szukanie…</p>}
      {state.kind === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      {state.kind === "ok" &&
        (state.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak zleceń{term ? " dla tej frazy" : ""}.</p>
        ) : (
          <>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {state.items.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(o)}
                    className="flex w-full flex-col items-start rounded-lg border px-3 py-1.5 text-left hover:bg-muted"
                  >
                    <span className="text-sm font-medium">
                      {o.name}
                      {!status && o.status !== "OPEN" && (
                        <span className="ml-2 text-xs text-muted-foreground">({ORDER_STATUS_LABELS[o.status].toLowerCase()})</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{orderSubLabel(o)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {state.total > state.items.length && (
              <p className="text-xs text-muted-foreground">
                Pokazano {state.items.length} z {state.total}. Doprecyzuj wyszukiwanie.
              </p>
            )}
          </>
        ))}
    </div>
  );
}

/** Wybrane zlecenie (nazwa + data/notatka) z przyciskiem zmiany. */
export function SelectedOrder({ order, onClear, clearLabel = "Zmień" }: { order: OrderDto; onClear?: () => void; clearLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{order.name}</div>
        <div className="text-xs text-muted-foreground">{orderSubLabel(order)}</div>
      </div>
      {onClear && (
        <button type="button" onClick={onClear} className="shrink-0 text-sm underline underline-offset-4">
          {clearLabel}
        </button>
      )}
    </div>
  );
}
