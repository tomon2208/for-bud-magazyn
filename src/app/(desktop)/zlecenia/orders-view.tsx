"use client";

import Link from "next/link";
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
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import {
  MAX_ORDER_NAME_LENGTH,
  MAX_ORDER_NOTES_LENGTH,
  MAX_ORDER_NUMBER_LENGTH,
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  createOrderSchema,
  type CreateOrderInput,
  type OrderStatus,
} from "@/lib/validation/orders";
import type { OrderDto, OrderOverviewDto, OrderPage } from "@/server/orders";

/** status: ISSUABLE (domyślnie: Otwarte + W produkcji), ALL (wszystkie) albo konkretny status. */
type Filters = { status: string; q: string };

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
export const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function buildUrl(f: Filters, page: number) {
  const params = new URLSearchParams();
  if (f.status && f.status !== "ISSUABLE") params.set("status", f.status);
  if (f.q) params.set("q", f.q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/zlecenia?${qs}` : "/zlecenia";
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  if (status === "OPEN") return <Badge>{ORDER_STATUS_LABELS.OPEN}</Badge>;
  if (status === "IN_PRODUCTION") {
    return (
      <Badge variant="outline" className="border-sky-600 bg-sky-50 text-sky-900">
        {ORDER_STATUS_LABELS.IN_PRODUCTION}
      </Badge>
    );
  }
  if (status === "DONE") return <Badge variant="secondary">{ORDER_STATUS_LABELS.DONE}</Badge>;
  return <Badge variant="destructive">{ORDER_STATUS_LABELS.CANCELLED}</Badge>;
}

/** Pytanie potwierdzenia przy zamknięciu zlecenia (null — zmiana bez potwierdzenia). */
export function statusChangeQuestion(name: string, status: OrderStatus): string | null {
  if (status === "DONE") {
    return `Zakończyć zlecenie „${name}”? Nie będzie można na nie wydawać (można je później otworzyć ponownie).`;
  }
  if (status === "CANCELLED") {
    return `Anulować zlecenie „${name}”? Nie będzie można na nie wydawać (można je później otworzyć ponownie).`;
  }
  return null;
}

/** Przyciski zmiany statusu zgodne z przepływem Otwarte → W produkcji → Zakończone/Anulowane (+ ponowne otwarcie). */
export function StatusButtons({
  status,
  busy,
  onChange,
}: {
  status: OrderStatus;
  busy: boolean;
  onChange: (status: OrderStatus) => void;
}) {
  const btn = (label: string, to: OrderStatus, variant: "outline" | "destructive" = "outline") => (
    <Button key={to} type="button" variant={variant} size="lg" disabled={busy} onClick={() => onChange(to)}>
      {label}
    </Button>
  );
  if (status === "OPEN") return <>{[btn("Do produkcji", "IN_PRODUCTION"), btn("Zakończ", "DONE"), btn("Anuluj", "CANCELLED", "destructive")]}</>;
  if (status === "IN_PRODUCTION") return <>{[btn("Zakończ", "DONE"), btn("Anuluj", "CANCELLED", "destructive"), btn("Cofnij do otwartych", "OPEN")]}</>;
  return btn("Otwórz ponownie", "OPEN");
}

export function OrdersView({ page, filters }: { page: OrderPage<OrderOverviewDto>; filters: Filters }) {
  const router = useRouter();
  const { run, busy, notice, setNotice } = useApiAction();
  const [editing, setEditing] = useState<OrderDto | "new" | null>(null);
  const [q, setQ] = useState(filters.q);

  useEffect(() => {
    if (q.trim() === filters.q) return;
    const timer = setTimeout(() => router.replace(buildUrl({ ...filters, q: q.trim() }, 1)), 300);
    return () => clearTimeout(timer);
  }, [q, filters, router]);

  function setStatus(o: OrderDto, status: OrderStatus) {
    const question = statusChangeQuestion(o.name, status);
    if (question && !window.confirm(question)) return;
    void run(
      () => callApi(`/api/v1/orders/${o.id}`, "PATCH", { status }),
      `Zlecenie „${o.name}”: ${ORDER_STATUS_LABELS[status].toLowerCase()}`,
    );
  }

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filtered = filters.q !== "" || filters.status !== "ISSUABLE";

  return (
    <div className="space-y-6">
      {editing ? (
        <OrderForm
          key={editing === "new" ? "new" : editing.id}
          order={editing === "new" ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={async (data) => {
            const isNew = editing === "new";
            const result = await run(
              () =>
                isNew
                  ? callApi("/api/v1/orders", "POST", data)
                  : callApi(`/api/v1/orders/${(editing as OrderDto).id}`, "PATCH", data),
              isNew ? `Dodano zlecenie „${data.name}”` : `Zapisano zlecenie „${data.name}”`,
            );
            if (result?.ok) setEditing(null);
            return result;
          }}
        />
      ) : (
        <Button type="button" onClick={() => (setNotice(null), setEditing("new"))}>
          Dodaj zlecenie
        </Button>
      )}

      <NoticeBox notice={notice} />

      <div className="flex flex-wrap items-end gap-4">
        <Input
          type="search"
          aria-label="Szukaj zlecenia"
          placeholder="Szukaj po nazwie lub numerze"
          value={q}
          maxLength={MAX_SEARCH_LENGTH}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-80"
        />
        <label className="flex flex-col gap-1 text-sm">
          Status
          <select
            value={filters.status}
            onChange={(e) => router.replace(buildUrl({ q: q.trim(), status: e.target.value }, 1))}
            className={SELECT_CLASS}
          >
            <option value="ISSUABLE">Otwarte i w produkcji</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
            <option value="ALL">wszystkie</option>
          </select>
        </label>
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filtered ? "Brak zleceń dla podanych filtrów." : "Brak zleceń. Dodaj pierwsze powyżej."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Numer</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Utworzono</TableHead>
                <TableHead className="text-right">Listy zapotrzebowania</TableHead>
                <TableHead>Braki</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-mono whitespace-nowrap">{o.number ?? "—"}</TableCell>
                  <TableCell className="max-w-md">
                    <Link href={`/zlecenia/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                      {o.name}
                    </Link>
                    {o.notes && <div className="truncate text-xs text-muted-foreground">{o.notes}</div>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{DATE.format(new Date(o.createdAt))}</TableCell>
                  <TableCell className="text-right">{o.requirementCount}</TableCell>
                  <TableCell>
                    {o.hasShortage ? (
                      <Link href={`/zlecenia/${o.id}#braki`} className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-semibold text-destructive">
                        są braki
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right whitespace-nowrap">
                    <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => (setNotice(null), setEditing(o))}>
                      Edytuj
                    </Button>
                    <StatusButtons status={o.status} busy={busy} onChange={(s) => setStatus(o, s)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted-foreground">
          {page.total} {pluralPl(page.total, "zlecenie", "zlecenia", "zleceń")} · strona {Math.min(page.page, totalPages)} z {totalPages}
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

export function OrderForm({
  order,
  busy,
  onCancel,
  onSubmit,
}: {
  order: OrderDto | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (data: CreateOrderInput) => Promise<{ ok: boolean; fields?: Record<string, string> } | null>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = createOrderSchema.safeParse({ name: form.get("name"), number: form.get("number"), notes: form.get("notes") });
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
        <CardTitle>{order ? `Edycja zlecenia: ${order.name}` : "Nowe zlecenie"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field id="ord-name" label="Nazwa (np. nazwisko klienta) *" error={errors.name}>
            <Input
              id="ord-name"
              name="name"
              defaultValue={order?.name}
              maxLength={MAX_ORDER_NAME_LENGTH}
              autoComplete="off"
              aria-invalid={!!errors.name}
            />
          </Field>
          <Field id="ord-number" label="Numer zlecenia (opcjonalnie, unikalny)" error={errors.number}>
            <Input
              id="ord-number"
              name="number"
              defaultValue={order?.number ?? ""}
              maxLength={MAX_ORDER_NUMBER_LENGTH}
              autoComplete="off"
              aria-invalid={!!errors.number}
            />
          </Field>
          <Field id="ord-notes" label="Notatka" error={errors.notes} className="sm:col-span-2">
            <textarea
              id="ord-notes"
              name="notes"
              defaultValue={order?.notes ?? ""}
              maxLength={MAX_ORDER_NOTES_LENGTH}
              className={TEXTAREA_CLASS}
            />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Nazwa nie musi być unikalna — przy wyborze zlecenia pokazujemy też numer, datę utworzenia i notatkę.
          </p>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {order ? "Zapisz zmiany" : "Dodaj zlecenie"}
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
