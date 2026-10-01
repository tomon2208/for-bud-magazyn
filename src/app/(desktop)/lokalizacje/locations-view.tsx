"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Field, NoticeBox } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction, zodFieldErrors } from "@/lib/api-client";
import { pluralPl } from "@/lib/format";
import { DEFAULT_PAGE_SIZE, MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import {
  createLocationSchema,
  generateLocationSeries,
  MAX_BULK_LOCATIONS,
  MAX_LOCATION_CODE_LENGTH,
} from "@/lib/validation/locations";
import type { LocationDto, LocationPage } from "@/server/locations";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type Filters = { q: string; includeInactive: boolean; pageSize: number };

function buildUrl(filters: Filters, page: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.includeInactive) params.set("includeInactive", "true");
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(filters.pageSize));
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/lokalizacje?${qs}` : "/lokalizacje";
}

function labelsUrl(ids: Iterable<string>) {
  return `/lokalizacje/etykiety?ids=${[...ids].join(",")}`;
}

type Mode = { kind: "none" } | { kind: "new" } | { kind: "edit"; location: LocationDto } | { kind: "series" };

export function LocationsView({
  page,
  canEdit,
  canPrint,
  filters,
}: {
  page: LocationPage;
  canEdit: boolean;
  canPrint: boolean;
  filters: Filters;
}) {
  const router = useRouter();
  const { run, busy, notice, setNotice } = useApiAction();
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  // Zaznaczenie (id → kod) zostaje przy zmianie strony i filtra.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());

  // Wyszukiwanie z debounce (jak w materiałach): pole odzwierciedla URL, własne wartości nie nadpisują wpisywanego tekstu.
  const [q, setQ] = useState(filters.q);
  const [sentQ, setSentQ] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  const { q: appliedQ, includeInactive, pageSize } = filters;
  if (appliedQ !== seenQ) {
    setSeenQ(appliedQ);
    if (appliedQ !== sentQ) {
      setQ(appliedQ);
      setSentQ(appliedQ);
    }
  }
  useEffect(() => {
    if (q.trim() === appliedQ) return;
    const timer = setTimeout(() => {
      setSentQ(q.trim());
      router.replace(buildUrl({ q: q.trim(), includeInactive, pageSize }, 1));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, appliedQ, includeInactive, pageSize, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const outOfRange = page.page > totalPages;
  useEffect(() => {
    if (outOfRange) router.replace(buildUrl({ q: appliedQ, includeInactive, pageSize }, totalPages));
  }, [outOfRange, totalPages, appliedQ, includeInactive, pageSize, router]);

  function toggleActive(l: LocationDto) {
    if (l.active && !window.confirm(`Dezaktywować lokalizację ${l.code}?`)) return;
    void run(
      () => callApi(`/api/v1/locations/${l.id}`, "PATCH", { active: !l.active }),
      l.active ? `Dezaktywowano ${l.code}` : `Aktywowano ${l.code}`,
    );
  }

  function toggleSelected(l: LocationDto) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(l.id)) next.delete(l.id);
      else next.set(l.id, l.code);
      return next;
    });
  }

  const allOnPageSelected = page.items.length > 0 && page.items.every((l) => selected.has(l.id));
  function togglePage() {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const l of page.items) {
        if (allOnPageSelected) next.delete(l.id);
        else next.set(l.id, l.code);
      }
      return next;
    });
  }

  const filtered = filters.q !== "";
  const selectionTooLarge = selected.size > MAX_BULK_LOCATIONS;

  return (
    <div className="space-y-6">
      {canEdit &&
        (mode.kind === "none" ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => (setNotice(null), setMode({ kind: "new" }))}>
              Dodaj lokalizację
            </Button>
            <Button type="button" variant="outline" onClick={() => (setNotice(null), setMode({ kind: "series" }))}>
              Dodaj serię (regał / półki / poziomy)
            </Button>
          </div>
        ) : mode.kind === "series" ? (
          <SeriesForm
            busy={busy}
            onCancel={() => setMode({ kind: "none" })}
            onSubmit={async (items) => {
              const result = await run(
                () => callApi("/api/v1/locations/bulk", "POST", { items }),
                `Dodano ${items.length} ${pluralPl(items.length, "lokalizację", "lokalizacje", "lokalizacji")}`,
              );
              if (result?.ok) {
                const created = (result.data as LocationDto[] | undefined) ?? [];
                setSelected(new Map(created.map((l) => [l.id, l.code])));
                setMode({ kind: "none" });
              }
              return result;
            }}
          />
        ) : (
          <LocationForm
            key={mode.kind === "edit" ? mode.location.id : "new"}
            location={mode.kind === "edit" ? mode.location : null}
            busy={busy}
            onCancel={() => setMode({ kind: "none" })}
            onSubmit={async (data) => {
              const result = await run(
                () =>
                  mode.kind === "edit"
                    ? callApi(`/api/v1/locations/${mode.location.id}`, "PATCH", data)
                    : callApi("/api/v1/locations", "POST", data),
                mode.kind === "edit" ? `Zapisano lokalizację ${data.code}` : `Dodano lokalizację ${data.code}`,
              );
              if (result?.ok) setMode({ kind: "none" });
              return result;
            }}
          />
        ))}

      <NoticeBox notice={notice} />

      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="search"
          aria-label="Szukaj lokalizacji"
          placeholder="Szukaj po kodzie lub nazwie"
          value={q}
          maxLength={MAX_SEARCH_LENGTH}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-72"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.includeInactive}
            onChange={(e) => router.replace(buildUrl({ ...filters, q: q.trim(), includeInactive: e.target.checked }, 1))}
          />
          Pokaż nieaktywne
        </label>
        {canPrint && selected.size > 0 && (
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span>
              Zaznaczono: <strong>{selected.size}</strong>
            </span>
            <Button type="button" variant="outline" size="lg" onClick={() => setSelected(new Map())}>
              Wyczyść
            </Button>
            {selectionTooLarge ? (
              <span className="text-destructive">Maksymalnie {MAX_BULK_LOCATIONS} etykiet naraz</span>
            ) : (
              <Link
                href={labelsUrl(selected.keys())}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
              >
                Drukuj etykiety
              </Link>
            )}
          </div>
        )}
      </div>

      {outOfRange ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Wczytywanie…</p>
      ) : page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filtered
            ? "Brak wyników dla podanej frazy."
            : canEdit
              ? "Brak lokalizacji. Dodaj pierwszą albo całą serię powyżej."
              : "Brak lokalizacji."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                {canPrint && (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Zaznacz wszystkie na stronie"
                      checked={allOnPageSelected}
                      onChange={togglePage}
                    />
                  </TableHead>
                )}
                <TableHead>Kod</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Opis</TableHead>
                <TableHead>Status</TableHead>
                {canEdit && <TableHead className="text-right">Akcje</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((l) => (
                <TableRow key={l.id}>
                  {canPrint && (
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Zaznacz ${l.code}`}
                        checked={selected.has(l.id)}
                        onChange={() => toggleSelected(l)}
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-mono font-semibold">{l.code}</TableCell>
                  <TableCell className="max-w-64 truncate" title={l.name ?? undefined}>
                    {l.name ?? "—"}
                  </TableCell>
                  <TableCell className="max-w-xs truncate" title={l.description ?? undefined}>
                    {l.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    {l.active ? <Badge variant="secondary">aktywna</Badge> : <Badge variant="destructive">nieaktywna</Badge>}
                  </TableCell>
                  {canEdit && (
                    <TableCell className="space-x-2 text-right whitespace-nowrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        disabled={busy}
                        onClick={() => (setNotice(null), setMode({ kind: "edit", location: l }))}
                      >
                        Edytuj
                      </Button>
                      <Button
                        type="button"
                        variant={l.active ? "destructive" : "outline"}
                        size="lg"
                        disabled={busy}
                        onClick={() => toggleActive(l)}
                      >
                        {l.active ? "Dezaktywuj" : "Aktywuj"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted-foreground">
          {page.total} {pluralPl(page.total, "lokalizacja", "lokalizacje", "lokalizacji")} · strona{" "}
          {Math.min(page.page, totalPages)} z {totalPages}
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

type LocationPayload = ReturnType<typeof createLocationSchema.parse>;
type SubmitResult = { ok: boolean; fields?: Record<string, string> } | null;

function LocationForm({
  location,
  busy,
  onCancel,
  onSubmit,
}: {
  location: LocationDto | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (data: LocationPayload) => Promise<SubmitResult>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [codeDraft, setCodeDraft] = useState(location?.code ?? "");
  const codeChanged = location !== null && codeDraft.trim().toUpperCase() !== location.code;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = createLocationSchema.safeParse({
      code: form.get("code"),
      name: form.get("name"),
      description: form.get("description"),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    const result = await onSubmit(parsed.data);
    if (result && !result.ok) setErrors(result.fields ?? {});
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{location ? `Edycja lokalizacji: ${location.code}` : "Nowa lokalizacja"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field id="loc-code" label="Kod *" error={errors.code}>
            <Input
              id="loc-code"
              name="code"
              value={codeDraft}
              onChange={(e) => setCodeDraft(e.target.value)}
              maxLength={MAX_LOCATION_CODE_LENGTH}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={!!errors.code}
              className="font-mono uppercase"
            />
            {codeChanged && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
                Uwaga: po zmianie kodu trzeba ponownie wydrukować i nakleić etykietę — stara etykieta przestanie działać.
              </p>
            )}
          </Field>
          <Field id="loc-name" label="Nazwa" error={errors.name}>
            <Input
              id="loc-name"
              name="name"
              defaultValue={location?.name ?? ""}
              maxLength={100}
              autoComplete="off"
              placeholder="np. Regał A, półka 3"
              aria-invalid={!!errors.name}
            />
          </Field>
          <Field id="loc-desc" label="Opis" error={errors.description} className="sm:col-span-2">
            <textarea
              id="loc-desc"
              name="description"
              defaultValue={location?.description ?? ""}
              maxLength={500}
              className={TEXTAREA_CLASS}
            />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {location ? "Zapisz zmiany" : "Dodaj lokalizację"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Anuluj
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SeriesForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (items: { code: string; name: string }[]) => Promise<SubmitResult>;
}) {
  const [rack, setRack] = useState("A");
  const [shelfFrom, setShelfFrom] = useState("1");
  const [shelfTo, setShelfTo] = useState("5");
  const [levelFrom, setLevelFrom] = useState("1");
  const [levelTo, setLevelTo] = useState("4");

  const series = useMemo(
    () =>
      generateLocationSeries({
        rack,
        shelfFrom: Number(shelfFrom),
        shelfTo: Number(shelfTo),
        levelFrom: Number(levelFrom),
        levelTo: Number(levelTo),
      }),
    [rack, shelfFrom, shelfTo, levelFrom, levelTo],
  );

  const numberInput = (id: string, label: string, value: string, set: (v: string) => void) => (
    <Field id={id} label={label}>
      <Input id={id} type="number" inputMode="numeric" min={1} max={999} value={value} onChange={(e) => set(e.target.value)} />
    </Field>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dodawanie seryjne lokalizacji</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Kody powstają wg wzorca <span className="font-mono">REGAŁ-PÓŁKA-POZIOM</span>, np.{" "}
          <span className="font-mono">A-01-01</span>. Zapis jest atomowy: jeśli któryś kod już istnieje, nie zapisze się nic.
        </p>
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Field id="ser-rack" label="Regał">
            <Input
              id="ser-rack"
              value={rack}
              onChange={(e) => setRack(e.target.value)}
              maxLength={10}
              autoComplete="off"
              autoCapitalize="characters"
              className="font-mono uppercase"
            />
          </Field>
          {numberInput("ser-shelf-from", "Półki od", shelfFrom, setShelfFrom)}
          {numberInput("ser-shelf-to", "Półki do", shelfTo, setShelfTo)}
          {numberInput("ser-level-from", "Poziomy od", levelFrom, setLevelFrom)}
          {numberInput("ser-level-to", "Poziomy do", levelTo, setLevelTo)}
        </div>

        {series.ok ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">
              Podgląd: {series.items.length} {pluralPl(series.items.length, "lokalizacja", "lokalizacje", "lokalizacji")}
            </div>
            <ul
              aria-label="Podgląd kodów"
              className="grid max-h-48 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto rounded-lg border p-3 font-mono text-sm sm:grid-cols-4 lg:grid-cols-6"
            >
              {series.items.map((i) => (
                <li key={i.code}>{i.code}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {series.message}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="button" disabled={busy || !series.ok} onClick={() => series.ok && void onSubmit(series.items)}>
            {series.ok
              ? `Zapisz ${series.items.length} ${pluralPl(series.items.length, "lokalizację", "lokalizacje", "lokalizacji")}`
              : "Zapisz"}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Anuluj
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
