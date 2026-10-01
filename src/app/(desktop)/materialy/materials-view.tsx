"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Field, NoticeBox, SELECT_CLASS } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction, zodFieldErrors } from "@/lib/api-client";
import { pluralPl } from "@/lib/format";
import {
  createMaterialSchema,
  DEFAULT_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  UNIT_SUGGESTIONS,
} from "@/lib/validation/catalog";
import type { CategoryDto, MaterialDto, MaterialPage, SupplierDto } from "@/server/catalog";

const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type Filters = { q: string; categoryId: string; includeInactive: boolean; pageSize: number };

function buildUrl(filters: Filters, page: number) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.includeInactive) params.set("includeInactive", "true");
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(filters.pageSize));
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/materialy?${qs}` : "/materialy";
}

export function MaterialsView({
  page,
  categories,
  suppliers,
  canEdit,
  filters,
}: {
  page: MaterialPage;
  categories: CategoryDto[];
  suppliers: SupplierDto[];
  canEdit: boolean;
  filters: Filters;
}) {
  const router = useRouter();
  const { run, busy, notice, setNotice } = useApiAction();
  const [editing, setEditing] = useState<MaterialDto | "new" | null>(null);

  // Wyszukiwanie z debounce: zmiana frazy aktualizuje URL (dane pobiera serwer), zawsze od strony 1.
  // Pole zawsze odzwierciedla URL: zmiana filtra z zewnątrz (menu, Wstecz) resetuje pole, a własne
  // wysłane wartości (sentQ) nie nadpisują tego, co użytkownik właśnie dopisał.
  const [q, setQ] = useState(filters.q);
  const [sentQ, setSentQ] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  const { q: appliedQ, categoryId, includeInactive, pageSize } = filters;
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
      router.replace(buildUrl({ q: q.trim(), categoryId, includeInactive, pageSize }, 1));
    }, 300);
    return () => clearTimeout(timer);
  }, [q, appliedQ, categoryId, includeInactive, pageSize, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  // Strona poza zakresem (np. po dezaktywacji ostatniego materiału na ostatniej stronie) → ostatnia strona.
  const outOfRange = page.page > totalPages;
  useEffect(() => {
    if (outOfRange) router.replace(buildUrl({ q: appliedQ, categoryId, includeInactive, pageSize }, totalPages));
  }, [outOfRange, totalPages, appliedQ, categoryId, includeInactive, pageSize, router]);

  function toggleActive(m: MaterialDto) {
    if (m.active && !window.confirm(`Dezaktywować materiał ${m.code} (${m.name})?`)) return;
    void run(
      () => callApi(`/api/v1/materials/${m.id}`, "PATCH", { active: !m.active }),
      m.active ? `Dezaktywowano ${m.code}` : `Aktywowano ${m.code}`,
    );
  }

  const filtered = filters.q !== "" || filters.categoryId !== "";

  return (
    <div className="space-y-6">
      {canEdit &&
        (editing ? (
          <MaterialForm
            key={editing === "new" ? "new" : editing.id}
            material={editing === "new" ? null : editing}
            categories={categories}
            suppliers={suppliers}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (data) => {
              const isNew = editing === "new";
              const result = await run(
                () =>
                  isNew
                    ? callApi("/api/v1/materials", "POST", data)
                    : callApi(`/api/v1/materials/${(editing as MaterialDto).id}`, "PATCH", data),
                isNew ? `Dodano materiał ${data.code}` : `Zapisano materiał ${data.code}`,
              );
              if (result?.ok) setEditing(null);
              return result;
            }}
          />
        ) : (
          <Button type="button" onClick={() => (setNotice(null), setEditing("new"))}>
            Dodaj materiał
          </Button>
        ))}

      <NoticeBox notice={notice} />

      <div className="flex flex-wrap items-center gap-4">
        <Input
          type="search"
          aria-label="Szukaj materiału"
          placeholder="Szukaj po kodzie lub nazwie"
          value={q}
          maxLength={MAX_SEARCH_LENGTH}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-72"
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
            checked={filters.includeInactive}
            onChange={(e) => router.replace(buildUrl({ ...filters, q: q.trim(), includeInactive: e.target.checked }, 1))}
          />
          Pokaż nieaktywne
        </label>
      </div>

      {outOfRange ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Wczytywanie…</p>
      ) : page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filtered
            ? "Brak wyników dla podanych filtrów."
            : canEdit
              ? "Brak materiałów. Dodaj pierwszy powyżej."
              : "Brak materiałów."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kod</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Kategoria</TableHead>
                <TableHead>Jednostka</TableHead>
                <TableHead>Domyślny dostawca</TableHead>
                <TableHead>Status</TableHead>
                {canEdit && <TableHead className="text-right">Akcje</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono">{m.code}</TableCell>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>{m.categoryName}</TableCell>
                  <TableCell>{m.unit}</TableCell>
                  <TableCell>{m.defaultSupplierName ?? "—"}</TableCell>
                  <TableCell>
                    {m.active ? <Badge variant="secondary">aktywny</Badge> : <Badge variant="destructive">nieaktywny</Badge>}
                  </TableCell>
                  {canEdit && (
                    <TableCell className="space-x-2 text-right whitespace-nowrap">
                      <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => (setNotice(null), setEditing(m))}>
                        Edytuj
                      </Button>
                      <Button
                        type="button"
                        variant={m.active ? "destructive" : "outline"}
                        size="lg"
                        disabled={busy}
                        onClick={() => toggleActive(m)}
                      >
                        {m.active ? "Dezaktywuj" : "Aktywuj"}
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
          {page.total} {pluralPl(page.total, "materiał", "materiały", "materiałów")} · strona {Math.min(page.page, totalPages)} z {totalPages}
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

type MaterialPayload = ReturnType<typeof createMaterialSchema.parse>;

function MaterialForm({
  material,
  categories,
  suppliers,
  busy,
  onCancel,
  onSubmit,
}: {
  material: MaterialDto | null;
  categories: CategoryDto[];
  suppliers: SupplierDto[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (data: MaterialPayload) => Promise<{ ok: boolean; fields?: Record<string, string> } | null>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Do wyboru tylko aktywne; bieżąca (nawet nieaktywna) wartość edytowanego materiału zostaje widoczna.
  const categoryOptions = categories.filter((c) => c.active || c.id === material?.categoryId);
  const supplierOptions = suppliers.filter((s) => s.active || s.id === material?.defaultSupplierId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const supplier = form.get("default_supplier_id");
    const parsed = createMaterialSchema.safeParse({
      code: form.get("code"),
      name: form.get("name"),
      category_id: form.get("category_id"),
      unit: form.get("unit"),
      default_supplier_id: supplier === "" ? null : supplier,
      notes: form.get("notes"),
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
        <CardTitle>{material ? `Edycja materiału: ${material.code}` : "Nowy materiał"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="mat-code" label="Kod *" error={errors.code}>
            <Input
              id="mat-code"
              name="code"
              defaultValue={material?.code}
              maxLength={50}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={!!errors.code}
              className="font-mono uppercase"
            />
          </Field>
          <Field id="mat-name" label="Nazwa *" error={errors.name} className="lg:col-span-3">
            <Input id="mat-name" name="name" defaultValue={material?.name} maxLength={200} autoComplete="off" aria-invalid={!!errors.name} />
          </Field>
          <Field id="mat-category" label="Kategoria *" error={errors.category_id}>
            <select
              id="mat-category"
              name="category_id"
              defaultValue={material?.categoryId ?? ""}
              className={`${SELECT_CLASS} w-full`}
              aria-invalid={!!errors.category_id}
            >
              <option value="">— wybierz —</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? "" : " (nieaktywna)"}
                </option>
              ))}
            </select>
          </Field>
          <Field id="mat-unit" label="Jednostka *" error={errors.unit}>
            <Input
              id="mat-unit"
              name="unit"
              list="unit-suggestions"
              defaultValue={material?.unit}
              maxLength={20}
              autoComplete="off"
              aria-invalid={!!errors.unit}
            />
            <datalist id="unit-suggestions">
              {UNIT_SUGGESTIONS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field id="mat-supplier" label="Domyślny dostawca" error={errors.default_supplier_id} className="lg:col-span-2">
            <select
              id="mat-supplier"
              name="default_supplier_id"
              defaultValue={material?.defaultSupplierId ?? ""}
              className={`${SELECT_CLASS} w-full`}
            >
              <option value="">— brak —</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? "" : " (nieaktywny)"}
                </option>
              ))}
            </select>
          </Field>
          <Field id="mat-notes" label="Uwagi" error={errors.notes} className="sm:col-span-2 lg:col-span-4">
            <textarea id="mat-notes" name="notes" defaultValue={material?.notes ?? ""} maxLength={2000} className={TEXTAREA_CLASS} />
          </Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={busy}>
              {material ? "Zapisz zmiany" : "Dodaj materiał"}
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
