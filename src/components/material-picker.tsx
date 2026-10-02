"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";

export type PickedMaterial = {
  id: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  defaultSupplierId: string | null;
  /** Z API materiałów (wyszukiwarka); brak = nieznane. */
  active?: boolean;
};

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; items: PickedMaterial[]; total: number }
  | { kind: "error"; message: string };

const PAGE_SIZE = 20;

/**
 * Wyszukiwarka aktywnych materiałów (kod/nazwa, debounce) z dużymi wierszami do dotyku.
 * Bez frazy pokazuje ostatnio używane (jeśli podane). `inStock` — tylko materiały, które są na stanie
 * (wydanie); wtedy także nieaktywne (mogą mieć jeszcze stan do wydania).
 */
export function MaterialPicker({
  onSelect,
  recent = [],
  size = "lg",
  autoFocus = false,
  inStock = false,
  includeInactive = false,
  recentLabel = "Ostatnio używane",
}: {
  onSelect: (m: PickedMaterial) => void;
  recent?: PickedMaterial[];
  size?: "lg" | "md";
  autoFocus?: boolean;
  inStock?: boolean;
  /** Także nieaktywne materiały (korekta ADMIN-a: zmniejszenie stanu nieaktywnego). */
  includeInactive?: boolean;
  recentLabel?: string;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const term = q.trim();

  useEffect(() => {
    if (term === "") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams({ q: term, pageSize: String(PAGE_SIZE) });
        if (inStock) params.set("inStock", "true");
        if (inStock || includeInactive) params.set("includeInactive", "true");
        const res = await fetch(`/api/v1/materials?${params}`, { signal: controller.signal });
        const json = (await res.json().catch(() => null)) as {
          data?: { items: PickedMaterial[]; total: number };
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
  }, [term, inStock, includeInactive]);

  const lg = size === "lg";
  const rowClass = lg
    ? "flex min-h-16 w-full flex-col items-start justify-center gap-0.5 rounded-xl border bg-background px-4 py-2 text-left active:bg-muted"
    : "flex min-h-11 w-full items-center gap-3 rounded-lg border bg-background px-3 py-1.5 text-left hover:bg-muted";

  const renderRow = (m: PickedMaterial) => (
      <li key={m.id}>
        <button type="button" className={rowClass} onClick={() => onSelect(m)}>
          <span className="flex w-full items-baseline justify-between gap-3">
            <span className={`font-mono font-bold break-all ${lg ? "text-xl" : "text-sm"}`}>{m.code}</span>
            <span className={`shrink-0 rounded-md bg-muted px-2 font-medium ${lg ? "text-base" : "text-xs"}`}>{m.unit}</span>
          </span>
          <span className={lg ? "text-base text-muted-foreground" : "text-sm text-muted-foreground"}>
            {m.name}
            {m.active === false && <span className="text-destructive"> (nieaktywny)</span>}
          </span>
        </button>
      </li>
  );

  const showRecent = term === "" && recent.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Szukaj materiału"
        placeholder="Kod lub nazwa materiału"
        value={q}
        maxLength={MAX_SEARCH_LENGTH}
        onChange={(e) => setQ(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        className={lg ? "h-14 rounded-xl px-4 text-xl" : "h-9"}
      />

      {showRecent && (
        <>
          <p className={lg ? "text-base font-semibold text-muted-foreground" : "text-xs text-muted-foreground"}>
            {recentLabel}
          </p>
          <ul className="flex flex-col gap-2">
            {recent.map(renderRow)}
          </ul>
        </>
      )}
      {term === "" && !showRecent && (
        <p className="text-muted-foreground">Wpisz kod lub fragment nazwy materiału.</p>
      )}
      {term !== "" && state.kind === "loading" && <p className="text-muted-foreground">Szukanie…</p>}
      {term !== "" && state.kind === "error" && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-destructive">
          {state.message}
        </p>
      )}
      {term !== "" && state.kind === "ok" && (
        <>
          {state.items.length === 0 ? (
            <p className="rounded-xl border bg-background p-4 text-center text-muted-foreground">
              {inStock
                ? "Brak materiałów na stanie dla tej frazy."
                : includeInactive
                  ? "Brak materiałów dla tej frazy."
                  : "Brak aktywnych materiałów dla tej frazy."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.items.map(renderRow)}
            </ul>
          )}
          {state.total > state.items.length && (
            <p className="text-center text-sm text-muted-foreground">
              Pokazano {state.items.length} z {state.total}. Doprecyzuj wyszukiwanie.
            </p>
          )}
        </>
      )}
    </div>
  );
}
