"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Field, UnresolvedAttemptAlert } from "@/components/form-parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { submitCreateSession, type CreateSessionPayload } from "@/lib/inventory-client";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import {
  MAX_CODE_PREFIX_LENGTH,
  MAX_SESSION_NAME_LENGTH,
  MAX_SESSION_NOTE_LENGTH,
} from "@/lib/validation/inventory";

type Loc = { id: string; code: string; name: string | null };
type Mode = "ALL" | "PREFIX" | "IDS";

/**
 * Nowa sesja inwentaryzacji: nazwa, notatka, lokalizacje (wszystkie aktywne / prefiks kodu, np. „A-” / zaznaczenie).
 * Podgląd liczby lokalizacji i ostrzeżenie o lokalizacjach w innej otwartej sesji (ostatecznie sprawdza baza).
 * Wynik nieznany (sieć) → dane zamrożone, ponowienie tym samym identyfikatorem (bez duplikatu sesji).
 */
export function CreateSessionForm({ locations, busyLocationIds }: { locations: Loc[]; busyLocationIds: string[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<Mode>("PREFIX");
  const [prefix, setPrefix] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const att = useOperationAttempt<CreateSessionPayload>();
  const busy = useMemo(() => new Set(busyLocationIds), [busyLocationIds]);

  const prefixNorm = prefix.trim().toUpperCase();
  const matching = useMemo(() => {
    if (mode === "ALL") return locations;
    if (mode === "PREFIX") return prefixNorm ? locations.filter((l) => l.code.startsWith(prefixNorm)) : [];
    return locations.filter((l) => selected.has(l.id));
  }, [mode, prefixNorm, locations, selected]);
  const conflicts = matching.filter((l) => busy.has(l.id));
  const visible = useMemo(() => {
    const f = filter.trim().toUpperCase();
    return f ? locations.filter((l) => l.code.includes(f) || (l.name ?? "").toUpperCase().includes(f)) : locations;
  }, [filter, locations]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    let payload: CreateSessionPayload | null = null;
    if (!att.unresolved) {
      if (!name.trim()) return setError("Podaj nazwę sesji");
      if (matching.length === 0) return setError("Wybierz co najmniej jedną lokalizację");
      if (conflicts.length > 0) return setError(`Lokalizacje są już w otwartej sesji: ${conflicts.slice(0, 10).map((l) => l.code).join(", ")}`);
      payload = {
        client_request_id: "",
        name: name.trim(),
        note: note.trim() || null,
        ...(mode === "ALL" ? { all_locations: true as const } : mode === "PREFIX" ? { code_prefix: prefixNorm } : { location_ids: [...selected] }),
      };
    }
    const res = await att.run(payload, submitCreateSession);
    if (!res) return;
    if (res.kind === "ok") {
      router.push(`/inwentaryzacja/${res.data.sessionId}`);
      return;
    }
    if (res.kind === "error") setError(res.message);
  }

  const locked = att.locked;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <h2 className="text-lg font-semibold">Nowa sesja inwentaryzacji</h2>
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="inv-name" label="Nazwa">
              <Input
                id="inv-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_SESSION_NAME_LENGTH}
                placeholder="np. Regał A — październik"
                disabled={locked}
              />
            </Field>
            <Field id="inv-note" label="Notatka (opcjonalnie)">
              <Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_SESSION_NOTE_LENGTH} disabled={locked} />
            </Field>
          </div>

          <fieldset className="space-y-2" disabled={locked}>
            <legend className="text-sm font-medium">Lokalizacje</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(
                [
                  ["PREFIX", "Wg prefiksu kodu"],
                  ["IDS", "Zaznaczone"],
                  ["ALL", "Wszystkie aktywne"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name="inv-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                  {label}
                </label>
              ))}
            </div>

            {mode === "PREFIX" && (
              <Field id="inv-prefix" label="Prefiks kodu lokalizacji">
                <Input
                  id="inv-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  maxLength={MAX_CODE_PREFIX_LENGTH}
                  placeholder="np. A-"
                  className="max-w-xs font-mono uppercase"
                />
              </Field>
            )}

            {mode === "IDS" && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Filtruj lokalizacje"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filtruj kod / nazwę"
                    className="max-w-xs"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelected((s) => new Set([...s, ...visible.map((l) => l.id)]))}>
                    Zaznacz widoczne
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                    Odznacz wszystkie
                  </Button>
                </div>
                <ul className="max-h-64 overflow-y-auto rounded-md border p-2 text-sm">
                  {visible.map((l) => (
                    <li key={l.id}>
                      <label className="flex items-center gap-2 py-0.5">
                        <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                        <span className="font-mono">{l.code}</span>
                        {l.name && <span className="text-muted-foreground">{l.name}</span>}
                        {busy.has(l.id) && <span className="text-xs text-amber-800">(w innej otwartej sesji)</span>}
                      </label>
                    </li>
                  ))}
                  {visible.length === 0 && <li className="text-muted-foreground">Brak lokalizacji.</li>}
                </ul>
              </div>
            )}

            <p className="text-sm">
              Wybrane lokalizacje: <span className="font-semibold">{matching.length}</span>
              {matching.length > 0 && matching.length <= 12 && (
                <span className="text-muted-foreground"> — {matching.map((l) => l.code).join(", ")}</span>
              )}
            </p>
            {conflicts.length > 0 && (
              <p role="alert" className="rounded-md bg-amber-100 p-2 text-sm text-amber-950">
                {conflicts.length} z wybranych lokalizacji jest już w innej otwartej sesji: {conflicts.slice(0, 10).map((l) => l.code).join(", ")}
                {conflicts.length > 10 ? "…" : ""}. Lokalizacja może być w jednej otwartej sesji naraz.
              </p>
            )}
          </fieldset>

          {att.unresolved && (
            <UnresolvedAttemptAlert status={att.attempt.status} what="sesja" saved="została utworzona" listName="sesji (odśwież stronę)" />
          )}
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={att.sending}>
              {att.sending ? "Tworzenie…" : att.unresolved ? "Ponów (ten sam identyfikator)" : "Utwórz sesję"}
            </Button>
            {att.unresolved && (
              <Button type="button" variant="outline" onClick={() => att.discard()}>
                Porzuć
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
