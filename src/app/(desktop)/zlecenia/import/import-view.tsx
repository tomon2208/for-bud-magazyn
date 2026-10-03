"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Field } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi } from "@/lib/api-client";
import { pluralPl } from "@/lib/format";
import { checkBarLength, createMaterialSchema, MATERIAL_CODE_REGEX, UNIT_SUGGESTIONS } from "@/lib/validation/catalog";
import { importRequirementSchema, MAX_RESOLVE_CODES } from "@/lib/validation/import";
import { MAX_ORDER_NAME_LENGTH, MAX_ORDER_NUMBER_LENGTH } from "@/lib/validation/orders";
import { MAX_REQUIREMENT_ITEMS, MAX_REQUIREMENT_NAME_LENGTH } from "@/lib/validation/requirements";
import { formatQuantity } from "@/lib/validation/stock";
import { formatLabel, parseImport } from "@/modules/liczokno-import/formats";
import { aggregateLines, cut, normalizeUnit, numberText, type AggregatedItem } from "@/modules/liczokno-import/normalize";
import { ACCEPTED_IMPORT_EXTENSIONS, MAX_IMPORT_FILE_BYTES, readWorkbookRows } from "@/modules/liczokno-import/read-workbook";
import {
  availabilityInfo,
  buildImportItems,
  buildPreview,
  sortRank,
  STATUS_META,
  summarizePreview,
  type CodeResolution,
  type ItemOverride,
  type PreviewItem,
  type PreviewStatus,
  type ResolvedMaterial,
  type StatusGroup,
} from "@/modules/liczokno-import/resolve";
import { buildImportPayload, requestIdFor, type RequestIdState } from "@/modules/liczokno-import/payload";
import { ImportParseError, type ParsedImport } from "@/modules/liczokno-import/types";
import type { ResolvedCodeDto } from "@/server/import";

// Import zapotrzebowania z LiczOkno (Etap 12a, ADR 016): plik → parsowanie W PRZEGLĄDARCE → dopasowanie kodów
// (API) → podgląd z decyzjami → zapis listy IMPORT (API). Do serwera trafia wyłącznie znormalizowany JSON.

export type ImportMode =
  | { kind: "existing"; orderId: string; orderName: string; activeFileNames: string[] }
  | { kind: "new" };

type Category = { id: string; name: string };

const DOC_DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeZone: "UTC" });

const GROUP_STYLE: Record<StatusGroup, string> = {
  ready: "bg-emerald-100 text-emerald-900",
  resolve: "bg-amber-100 text-amber-950",
  skipped: "bg-muted text-muted-foreground",
};

type RowFilter = "all" | StatusGroup;

function fileBaseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

function toMaterial(m: PickedMaterial): ResolvedMaterial {
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    unit: m.unit,
    allowsFraction: m.allowsFraction,
    barLengthM: m.barLengthM ?? null,
    active: m.active ?? true,
  };
}

function toResolutionMap(rows: ResolvedCodeDto[]): Map<string, CodeResolution> {
  return new Map(
    rows.map((r) => [r.code, { code: r.code, status: r.status, aliasId: r.aliasId, material: r.material } satisfies CodeResolution]),
  );
}

/**
 * Jednostka materiału założonego z pliku: profil (grupa „Profile…”) → „szt.” (sztanga jest jednostką magazynową,
 * CLAUDE.md reguła 6), pozostałe: „m” → „mb”, „szt.” → „szt.”, inne bez zmian.
 */
export function suggestUnit(fileUnit: string, isProfile = false): string {
  if (isProfile) return "szt.";
  const u = normalizeUnit(fileUnit);
  if (u === "m") return "mb";
  if (u === "szt") return "szt.";
  return cut(fileUnit.trim(), 20);
}

export function ImportView({ mode, isAdmin, categories }: { mode: ImportMode; isAdmin: boolean; categories: Category[] }) {
  const router = useRouter();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Wynik dopasowania kodów (zmieniany lokalnie po zapisie powiązania / założeniu materiału) i jego pierwotna wersja
  // (tylko do kolejności wierszy — wiersz nie „skacze” po rozwiązaniu).
  const [resolutions, setResolutions] = useState<Map<string, CodeResolution>>(new Map());
  const [baseResolutions, setBaseResolutions] = useState<Map<string, CodeResolution>>(new Map());
  const [includeProfiles, setIncludeProfiles] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, ItemOverride>>({});
  const [filter, setFilter] = useState<RowFilter>("all");
  const [panel, setPanel] = useState<{ key: string; kind: "pick" | "create" } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [listName, setListName] = useState("");
  const [orderName, setOrderName] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFields, setSaveFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const saveLock = useRef(false);
  // Identyfikator żądania (idempotencja, wzorzec M1 z ADR 013): ten sam dla identycznej treści, nowy po jej zmianie.
  const sent = useRef<RequestIdState>(null);

  const items: AggregatedItem[] = useMemo(() => (parsed ? aggregateLines(parsed.lines) : []), [parsed]);
  const overrideMap = useMemo(() => new Map(Object.entries(overrides)), [overrides]);
  const preview = useMemo(
    () => buildPreview(items, resolutions, { includeProfiles }, overrideMap),
    [items, resolutions, includeProfiles, overrideMap],
  );
  const baseRank = useMemo(() => {
    const ranks = new Map<string, number>();
    for (const p of buildPreview(items, baseResolutions, { includeProfiles })) ranks.set(p.key, sortRank(p.status));
    return ranks;
  }, [items, baseResolutions, includeProfiles]);
  const sorted = useMemo(
    () => [...preview].sort((a, b) => (baseRank.get(a.key) ?? 1) - (baseRank.get(b.key) ?? 1)),
    [preview, baseRank],
  );
  const visible = useMemo(
    () => (filter === "all" ? sorted : sorted.filter((p) => STATUS_META[p.status].group === filter)),
    [sorted, filter],
  );
  const summary = useMemo(() => summarizePreview(preview), [preview]);
  const { items: importItems, merged } = useMemo(() => buildImportItems(preview), [preview]);
  const profileCount = useMemo(() => items.filter((i) => i.isProfile).length, [items]);

  async function onFile(file: File) {
    setLoading(true);
    setParseError(null);
    setParsed(null);
    setFileName(null);
    setOverrides({});
    setRowErrors({});
    setPanel(null);
    setSaveError(null);
    setSaveFields({});
    sent.current = null;
    try {
      const rows = await readWorkbookRows(file);
      const result = parseImport(rows);
      const aggregated = aggregateLines(result.lines);
      const codes = aggregated.map((i) => i.key).filter((c) => c.length <= 200);
      if (codes.length > MAX_RESOLVE_CODES) {
        throw new ImportParseError(`Plik ma zbyt wiele różnych kodów (${codes.length}, maksymalnie ${MAX_RESOLVE_CODES})`);
      }
      const res = await callApi("/api/v1/import/resolve", "POST", { codes });
      if (!res.ok) throw new ImportParseError(res.message);
      const map = toResolutionMap((res.data ?? []) as ResolvedCodeDto[]);
      setResolutions(map);
      setBaseResolutions(map);
      setParsed(result);
      setFileName(file.name);
      const fallback = fileBaseName(file.name);
      setListName(cut(result.orderNameHint ?? fallback, MAX_REQUIREMENT_NAME_LENGTH));
      setOrderName(cut(result.orderNameHint ?? fallback, MAX_ORDER_NAME_LENGTH));
      setOrderNumber("");
    } catch (e) {
      setParseError(e instanceof ImportParseError ? e.message : "Nie udało się odczytać pliku");
    } finally {
      setLoading(false);
    }
  }

  function setOverride(key: string, patch: Partial<ItemOverride> | null) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[key];
      else next[key] = { ...prev[key], ...patch };
      return next;
    });
  }
  const setRowError = (key: string, message: string | null) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });

  /** Odświeża dopasowanie jednego kodu z bazy (po cofnięciu „nie magazynujemy”). */
  async function refreshResolution(key: string): Promise<boolean> {
    const res = await callApi("/api/v1/import/resolve", "POST", { codes: [key] });
    if (!res.ok) {
      setRowError(key, res.message);
      return false;
    }
    const row = ((res.data ?? []) as ResolvedCodeDto[])[0];
    setResolutions((prev) => {
      const next = new Map(prev);
      if (row) next.set(key, { code: key, status: row.status, aliasId: row.aliasId, material: row.material });
      return next;
    });
    return true;
  }

  async function chooseMaterial(item: PreviewItem, picked: PickedMaterial, remember: boolean) {
    const material = toMaterial(picked);
    setRowError(item.key, null);
    setBusyKey(item.key);
    try {
      if (remember) {
        const res = await callApi("/api/v1/import/aliases", "PUT", { source_code: item.key, action: "MAP", material_id: picked.id });
        if (!res.ok) {
          setRowError(item.key, res.message);
          return;
        }
        const aliasId = (res.data as { id?: string } | undefined)?.id ?? null;
        setResolutions((prev) => new Map(prev).set(item.key, { code: item.key, status: "ALIAS_MAP", aliasId, material }));
        setOverride(item.key, null);
      } else {
        setOverride(item.key, { material, skip: false, quantityText: undefined });
      }
      setPanel(null);
    } finally {
      setBusyKey(null);
    }
  }

  async function markIgnored(item: PreviewItem) {
    setRowError(item.key, null);
    setBusyKey(item.key);
    try {
      const res = await callApi("/api/v1/import/aliases", "PUT", { source_code: item.key, action: "IGNORE" });
      if (!res.ok) {
        setRowError(item.key, res.message);
        return;
      }
      const aliasId = (res.data as { id?: string } | undefined)?.id ?? null;
      setResolutions((prev) => new Map(prev).set(item.key, { code: item.key, status: "IGNORED", aliasId, material: null }));
      setOverride(item.key, null);
      setPanel(null);
    } finally {
      setBusyKey(null);
    }
  }

  async function undoIgnored(item: PreviewItem) {
    setRowError(item.key, null);
    setBusyKey(item.key);
    try {
      const aliasId = resolutions.get(item.key)?.aliasId;
      if (aliasId) {
        const res = await callApi(`/api/v1/import/aliases/${aliasId}`, "DELETE");
        // 404 = oznaczenie już usunięte (np. na stronie powiązań) — też kończy się odświeżeniem dopasowania.
        if (!res.ok && !/nie znaleziono/i.test(res.message)) {
          setRowError(item.key, res.message);
          return;
        }
      }
      await refreshResolution(item.key);
    } finally {
      setBusyKey(null);
    }
  }

  function materialCreated(item: PreviewItem, material: ResolvedMaterial) {
    setResolutions((prev) => new Map(prev).set(item.key, { code: item.key, status: "MATERIAL", aliasId: null, material }));
    setOverride(item.key, null);
    setPanel(null);
  }

  const targetOrderId = mode.kind === "existing" ? mode.orderId : null;
  const duplicateFile = mode.kind === "existing" && fileName !== null && mode.activeFileNames.includes(fileName);
  const tooMany = importItems.length > MAX_REQUIREMENT_ITEMS;
  const canSave =
    parsed !== null && !saving && !done && summary.toResolve === 0 && importItems.length > 0 && !tooMany && listName.trim() !== "" &&
    (mode.kind === "existing" || orderName.trim() !== "");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!parsed || !fileName || !canSave || saveLock.current) return;
    const { body, key } = buildImportPayload({
      targetOrderId,
      orderName,
      orderNumber,
      listName,
      fileName,
      formatId: parsed.formatId,
      items: importItems,
    });
    sent.current = requestIdFor(sent.current, key, () => crypto.randomUUID());
    const check = importRequirementSchema.safeParse({ ...body, client_request_id: sent.current.id });
    if (!check.success) {
      const first = check.error.issues[0];
      setSaveFields({});
      setSaveError(first?.message ?? "Nieprawidłowe dane");
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveFields({});
    let succeeded = false;
    try {
      const result = await callApi("/api/v1/import/requirements", "POST", check.data);
      if (result.ok) {
        const orderId = (result.data as { orderId?: string } | undefined)?.orderId ?? targetOrderId;
        // Zostajemy w stanie „zapisywanie” — przekierowanie na kartę zlecenia (sekcja Braki pokazuje porównanie z magazynem).
        succeeded = true;
        setDone(true);
        router.push(orderId ? `/zlecenia/${orderId}` : "/zlecenia");
        return;
      }
      setSaveFields(result.fields);
      setSaveError(result.message);
    } finally {
      // Po sukcesie przycisk zostaje zablokowany (przekierowanie w toku) — bez drugiego zapisu.
      if (!succeeded) {
        saveLock.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>1. Wybierz plik z LiczOkno</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Obsługiwane pliki: {ACCEPTED_IMPORT_EXTENSIONS.join(", ")} (do {MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB). Plik jest
            odczytywany w przeglądarce — na serwer trafia tylko lista pozycji.
          </p>
          <input
            type="file"
            accept={ACCEPTED_IMPORT_EXTENSIONS.join(",")}
            aria-label="Plik LiczOkno"
            disabled={loading || saving}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = "";
            }}
            className="block w-full max-w-xl text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
          />
          {loading && <p role="status" className="text-sm text-muted-foreground">Odczytywanie pliku…</p>}
          {parseError && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {parseError}
            </p>
          )}
          {parsed && fileName && (
            <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Plik</dt>
              <dd className="font-medium break-all">{fileName}</dd>
              <dt className="text-muted-foreground">Format</dt>
              <dd>{formatLabel(parsed.formatId)}</dd>
              <dt className="text-muted-foreground">Zlecenie w pliku</dt>
              <dd>{parsed.orderNameHint ?? "—"}</dd>
              <dt className="text-muted-foreground">Data dokumentu</dt>
              <dd>{parsed.documentDate ? DOC_DATE.format(new Date(`${parsed.documentDate}T00:00:00Z`)) : "—"}</dd>
              <dt className="text-muted-foreground">Pozycje</dt>
              <dd>
                {items.length} {pluralPl(items.length, "kod", "kody", "kodów")} ({parsed.lines.length}{" "}
                {pluralPl(parsed.lines.length, "wiersz", "wiersze", "wierszy")})
              </dd>
            </dl>
          )}
        </CardContent>
      </Card>

      {parsed && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>2. Sprawdź i rozwiąż pozycje</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeProfiles}
                  onChange={(e) => setIncludeProfiles(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">Szukaj też profili</span>
                  <span className="block text-muted-foreground">
                    Domyślnie pozycje z grup „Profile…” ({profileCount}) są pomijane. Po włączeniu metry z pliku są
                    przeliczane na sztangi wg długości sztangi z kartoteki.
                  </span>
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="rounded-md bg-emerald-100 px-2 py-1 font-medium text-emerald-900">Gotowe: {summary.ready}</span>
                <span
                  className={`rounded-md px-2 py-1 font-medium ${summary.toResolve > 0 ? "bg-amber-100 text-amber-950" : "bg-muted text-muted-foreground"}`}
                >
                  Do rozwiązania: {summary.toResolve}
                </span>
                <span className="rounded-md bg-muted px-2 py-1 font-medium text-muted-foreground">Pominięte: {summary.skipped}</span>
                <label className="ml-auto flex items-center gap-2">
                  Pokaż
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as RowFilter)}
                    className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="all">wszystkie</option>
                    <option value="resolve">do rozwiązania</option>
                    <option value="ready">gotowe</option>
                    <option value="skipped">pominięte</option>
                  </select>
                </label>
              </div>

              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kod / opis</TableHead>
                      <TableHead className="text-right">Z pliku</TableHead>
                      <TableHead>Materiał</TableHead>
                      <TableHead>Ilość na listę</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Akcje</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          Brak pozycji dla tego filtra.
                        </TableCell>
                      </TableRow>
                    )}
                    {visible.map((p) => (
                      <PreviewRow
                        key={p.key}
                        p={p}
                        override={overrides[p.key]}
                        resolution={resolutions.get(p.key)}
                        isAdmin={isAdmin}
                        panel={panel?.key === p.key ? panel.kind : null}
                        busy={busyKey === p.key}
                        error={rowErrors[p.key] ?? null}
                        categories={categories}
                        onQuantity={(text) => setOverride(p.key, { quantityText: text })}
                        onOpen={(kind) => (setRowError(p.key, null), setPanel({ key: p.key, kind }))}
                        onClose={() => setPanel(null)}
                        onChoose={(m, remember) => void chooseMaterial(p, m, remember)}
                        onIgnore={() => void markIgnored(p)}
                        onUndoIgnore={() => void undoIgnored(p)}
                        onSkip={() => setOverride(p.key, { skip: true })}
                        onUnskip={() => setOverride(p.key, { skip: false })}
                        onCreated={(m) => materialCreated(p, m)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>3. Zapisz listę zapotrzebowania</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={save} noValidate className="space-y-4">
                {mode.kind === "new" && (
                  <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                    <Field id="imp-order-name" label="Nazwa zlecenia *" error={saveFields["new_order.name"]}>
                      <Input
                        id="imp-order-name"
                        value={orderName}
                        maxLength={MAX_ORDER_NAME_LENGTH}
                        onChange={(e) => setOrderName(e.target.value)}
                        autoComplete="off"
                      />
                    </Field>
                    <Field id="imp-order-number" label="Numer zlecenia (opcjonalnie)" error={saveFields.number ?? saveFields["new_order.number"]}>
                      <Input
                        id="imp-order-number"
                        value={orderNumber}
                        maxLength={MAX_ORDER_NUMBER_LENGTH}
                        onChange={(e) => setOrderNumber(e.target.value)}
                        autoComplete="off"
                        aria-invalid={!!saveFields.number}
                      />
                    </Field>
                  </div>
                )}
                {mode.kind === "existing" && (
                  <p className="text-sm text-muted-foreground">
                    Zlecenie: <span className="font-medium text-foreground">{mode.orderName}</span>
                  </p>
                )}
                <Field id="imp-list-name" label="Nazwa listy *" error={saveFields.name} className="max-w-xl">
                  <Input
                    id="imp-list-name"
                    value={listName}
                    maxLength={MAX_REQUIREMENT_NAME_LENGTH}
                    onChange={(e) => setListName(e.target.value)}
                    autoComplete="off"
                  />
                </Field>

                {duplicateFile && (
                  <p role="status" className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">
                    Uwaga: to zlecenie ma już aktywną listę zaimportowaną z pliku „{fileName}”. Zapisanie doda kolejną —
                    zapotrzebowania zostaną zsumowane. Jeśli to ten sam plik, wycofaj poprzednią listę.
                  </p>
                )}
                {merged > 0 && (
                  <p role="status" className="rounded-md bg-muted p-3 text-sm">
                    {merged} {pluralPl(merged, "pozycja wskazuje", "pozycje wskazują", "pozycji wskazuje")} ten sam materiał co
                    inna pozycja — ilości zostaną zsumowane w jedną pozycję listy.
                  </p>
                )}
                {tooMany && (
                  <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    Lista może mieć maksymalnie {MAX_REQUIREMENT_ITEMS} pozycji (jest {importItems.length}) — pomiń część pozycji.
                  </p>
                )}
                {summary.toResolve > 0 && (
                  <p className="text-sm text-amber-950">
                    Do rozwiązania: {summary.toResolve} — wskaż materiał, wpisz ilość albo pomiń pozycję, aby zapisać listę.
                  </p>
                )}
                {saveError && (
                  <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {saveError}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" size="lg" disabled={!canSave}>
                    {saving ? "Zapisywanie…" : `Zapisz listę (${importItems.length} ${pluralPl(importItems.length, "pozycja", "pozycje", "pozycji")})`}
                  </Button>
                  <Link
                    href={mode.kind === "existing" ? `/zlecenia/${mode.orderId}` : "/zlecenia"}
                    className="text-sm underline underline-offset-4"
                  >
                    Anuluj
                  </Link>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PreviewStatus }) {
  const meta = STATUS_META[status];
  return <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${GROUP_STYLE[meta.group]}`}>{meta.label}</span>;
}

function PreviewRow({
  p,
  override,
  resolution,
  isAdmin,
  panel,
  busy,
  error,
  categories,
  onQuantity,
  onOpen,
  onClose,
  onChoose,
  onIgnore,
  onUndoIgnore,
  onSkip,
  onUnskip,
  onCreated,
}: {
  p: PreviewItem;
  override: ItemOverride | undefined;
  resolution: CodeResolution | undefined;
  isAdmin: boolean;
  panel: "pick" | "create" | null;
  busy: boolean;
  error: string | null;
  categories: Category[];
  onQuantity: (text: string) => void;
  onOpen: (kind: "pick" | "create") => void;
  onClose: () => void;
  onChoose: (m: PickedMaterial, remember: boolean) => void;
  onIgnore: () => void;
  onUndoIgnore: () => void;
  onSkip: () => void;
  onUnskip: () => void;
  onCreated: (m: ResolvedMaterial) => void;
}) {
  const group = STATUS_META[p.status].group;
  const qtyEditable = p.material !== null && p.status !== "POMINIETY_RECZNIE" && p.status !== "NIE_MAGAZYNUJEMY" && p.status !== "PROFIL_POMINIETY";
  const qtyValue = override?.quantityText ?? (p.suggestedQuantity !== null ? numberText(p.suggestedQuantity) : "");
  const rowTone = group === "resolve" ? "bg-amber-50/60" : group === "skipped" ? "text-muted-foreground" : "";

  return (
    <>
      <TableRow className={rowTone}>
        <TableCell className="max-w-xs align-top">
          <div className="font-mono text-sm break-all">{p.code}</div>
          {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
          {p.group && <div className="text-xs text-muted-foreground">grupa: {p.group}</div>}
        </TableCell>
        <TableCell className="text-right align-top whitespace-nowrap">
          <span className="font-semibold">{formatQuantity(p.fileQuantity)}</span> {p.fileUnit}
          {p.sourceRows.length > 1 && <div className="text-xs text-muted-foreground">{p.sourceRows.length} wiersze</div>}
        </TableCell>
        <TableCell className="max-w-xs align-top">
          {p.material ? (
            <>
              <div className="font-mono text-sm break-all">{p.material.code}</div>
              <div className="text-xs text-muted-foreground">{p.material.name}</div>
              {resolution?.status === "ALIAS_MAP" && !override?.material && <div className="text-xs text-sky-800">powiązanie zapamiętane</div>}
              {override?.material && <div className="text-xs text-sky-800">wskazany tylko teraz</div>}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="align-top">
          {qtyEditable ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Input
                  value={qtyValue}
                  onChange={(e) => onQuantity(e.target.value)}
                  inputMode="decimal"
                  aria-label={`Ilość na listę ${p.code}`}
                  aria-invalid={!!p.quantityError}
                  placeholder="ilość"
                  className="h-9 w-24"
                />
                <span className="text-sm text-muted-foreground">{p.material?.unit}</span>
              </div>
              {p.conversion && (
                <div className="text-xs text-sky-800">{p.manual ? `proponowano: ${p.conversion}` : p.conversion}</div>
              )}
              {p.quantityError && <div className="text-xs text-destructive">{p.quantityError}</div>}
              {availabilityInfo(p) && <div className="text-xs text-amber-800">{availabilityInfo(p)}</div>}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="max-w-xs align-top">
          <StatusBadge status={p.status} />
          {p.message && p.status !== "BLAD_ILOSCI" && <div className="mt-1 text-xs">{p.message}</div>}
        </TableCell>
        <TableCell className="align-top">
          <div className="flex flex-wrap gap-1.5">
            {p.status === "NIE_MAGAZYNUJEMY" ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onUndoIgnore}>
                Cofnij oznaczenie
              </Button>
            ) : p.status === "POMINIETY_RECZNIE" ? (
              <Button type="button" size="sm" variant="outline" onClick={onUnskip}>
                Przywróć
              </Button>
            ) : p.status === "PROFIL_POMINIETY" ? (
              <span className="text-xs text-muted-foreground">włącz „Szukaj też profili”</span>
            ) : (
              <>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpen("pick")}>
                  {p.status === "NIEZNANY" ? "Wskaż materiał" : "Zmień materiał"}
                </Button>
                {p.status === "NIEZNANY" && isAdmin && (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpen("create")}>
                    Załóż materiał
                  </Button>
                )}
                {group === "resolve" && (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onIgnore}>
                    Nie magazynujemy
                  </Button>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSkip}>
                  Pomiń tylko teraz
                </Button>
              </>
            )}
          </div>
          {error && <div role="alert" className="mt-1 text-xs text-destructive">{error}</div>}
        </TableCell>
      </TableRow>
      {panel && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/40">
            {panel === "pick" ? (
              <PickPanel item={p} busy={busy} onChoose={onChoose} onClose={onClose} />
            ) : (
              <CreatePanel item={p} categories={categories} onCreated={onCreated} onClose={onClose} />
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function PickPanel({
  item,
  busy,
  onChoose,
  onClose,
}: {
  item: PreviewItem;
  busy: boolean;
  onChoose: (m: PickedMaterial, remember: boolean) => void;
  onClose: () => void;
}) {
  // Kod niezgodny z formatem kodu materiału nie może zostać zapamiętany (baza odrzuca go jako INVALID_CODE).
  const rememberable = MATERIAL_CODE_REGEX.test(item.key);
  const [remember, setRemember] = useState(rememberable);
  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm font-medium">
        Wskaż materiał dla kodu <span className="font-mono">{item.code}</span>
      </p>
      <MaterialPicker size="md" autoFocus onSelect={(m) => onChoose(m, remember)} />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rememberable && remember}
          onChange={(e) => setRemember(e.target.checked)}
          disabled={busy || !rememberable}
        />
        Zapamiętaj powiązanie (kolejne importy dopasują ten kod automatycznie)
      </label>
      {!rememberable && (
        <p className="text-xs text-muted-foreground">
          Tego kodu nie można zapamiętać (dozwolone: A–Z, cyfry, . _ / - i pojedyncze spacje, do 50 znaków) — wskazanie
          obowiązuje tylko w tym imporcie.
        </p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        Anuluj
      </Button>
    </div>
  );
}

function CreatePanel({
  item,
  categories,
  onCreated,
  onClose,
}: {
  item: PreviewItem;
  categories: Category[];
  onCreated: (m: ResolvedMaterial) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(cut(item.description || item.code, 200));
  const [unit, setUnit] = useState(suggestUnit(item.fileUnit, item.isProfile));
  const [categoryId, setCategoryId] = useState("");
  const [barLength, setBarLength] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const barCheck = checkBarLength(barLength);
  const metersWithBar = normalizeUnit(unit) === "m" && barCheck.ok && barCheck.value !== null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    // Profil: długość sztangi wymagana (bez niej metry z pliku nie przeliczą się na sztangi).
    if (item.isProfile && barLength.trim() === "") {
      setErrors({ bar_length_m: "Podaj długość sztangi — profil jest magazynowany w sztangach" });
      return;
    }
    const parsed = createMaterialSchema.safeParse({
      code: item.key,
      name,
      category_id: categoryId,
      unit,
      bar_length_m: barLength,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? "_")] ??= issue.message;
      setErrors(next);
      return;
    }
    lock.current = true;
    setBusy(true);
    setErrors({});
    try {
      const result = await callApi("/api/v1/materials", "POST", parsed.data);
      if (!result.ok) {
        setErrors({ ...result.fields, _: result.message });
        return;
      }
      const m = result.data as PickedMaterial & { barLengthM?: number | null };
      onCreated({
        id: m.id,
        code: m.code,
        name: m.name,
        unit: m.unit,
        allowsFraction: m.allowsFraction,
        barLengthM: m.barLengthM ?? null,
        active: m.active ?? true,
      });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <p className="text-sm font-medium sm:col-span-2 lg:col-span-4">Nowy materiał z pliku (kod z pliku)</p>
      <Field id={`cm-code-${item.key}`} label="Kod" error={errors.code}>
        <Input id={`cm-code-${item.key}`} value={item.key} readOnly className="font-mono" />
      </Field>
      <Field id={`cm-name-${item.key}`} label="Nazwa *" error={errors.name} className="lg:col-span-3">
        <Input id={`cm-name-${item.key}`} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Field id={`cm-cat-${item.key}`} label="Kategoria *" error={errors.category_id}>
        <select
          id={`cm-cat-${item.key}`}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
        >
          <option value="">— wybierz —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`cm-unit-${item.key}`} label="Jednostka *" error={errors.unit}>
        <Input
          id={`cm-unit-${item.key}`}
          value={unit}
          list={`cm-units-${item.key}`}
          maxLength={20}
          onChange={(e) => setUnit(e.target.value)}
          autoComplete="off"
        />
        <datalist id={`cm-units-${item.key}`}>
          {UNIT_SUGGESTIONS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      </Field>
      <Field
        id={`cm-bar-${item.key}`}
        label={item.isProfile ? "Długość sztangi [m] *" : "Długość sztangi [m] (opcjonalnie)"}
        error={errors.bar_length_m}
      >
        <Input
          id={`cm-bar-${item.key}`}
          value={barLength}
          inputMode="decimal"
          maxLength={8}
          onChange={(e) => setBarLength(e.target.value)}
          autoComplete="off"
          placeholder="np. 6,5"
        />
      </Field>
      {metersWithBar && (
        <p role="status" className="text-sm text-amber-950 sm:col-span-2 lg:col-span-4">
          Jednostka materiału to metry — długość sztangi nie będzie miała skutku (przeliczanie dotyczy materiałów
          liczonych w sztukach / sztangach). Zmień jednostkę na „szt.” albo wyczyść długość sztangi.
        </p>
      )}
      {errors._ && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2 lg:col-span-4">
          {errors._}
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" disabled={busy}>
          {busy ? "Zapisywanie…" : "Załóż materiał"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Anuluj
        </Button>
      </div>
    </form>
  );
}
