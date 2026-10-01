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
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  createOrderSchema,
  type CreateOrderInput,
  type OrderStatus,
} from "@/lib/validation/orders";
import type { OrderDto, OrderPage } from "@/server/orders";

type Filters = { status: string; q: string };

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const TEXTAREA_CLASS =
  "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function buildUrl(f: Filters, page: number) {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.q) params.set("q", f.q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/zlecenia?${qs}` : "/zlecenia";
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  if (status === "OPEN") return <Badge>{ORDER_STATUS_LABELS.OPEN}</Badge>;
  if (status === "DONE") return <Badge variant="secondary">{ORDER_STATUS_LABELS.DONE}</Badge>;
  return <Badge variant="destructive">{ORDER_STATUS_LABELS.CANCELLED}</Badge>;
}

export function OrdersView({ page, filters }: { page: OrderPage; filters: Filters }) {
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
    const question =
      status === "DONE"
        ? `Zakończyć zlecenie „${o.name}”? Nie będzie można na nie wydawać (można je później otworzyć ponownie).`
        : status === "CANCELLED"
          ? `Anulować zlecenie „${o.name}”? Nie będzie można na nie wydawać (można je później otworzyć ponownie).`
          : null;
    if (question && !window.confirm(question)) return;
    void run(
      () => callApi(`/api/v1/orders/${o.id}`, "PATCH", { status }),
      `Zlecenie „${o.name}”: ${ORDER_STATUS_LABELS[status].toLowerCase()}`,
    );
  }

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));

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
          placeholder="Szukaj po nazwie (np. nazwisko klienta)"
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
            <option value="">wszystkie</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {filters.q || filters.status ? "Brak zleceń dla podanych filtrów." : "Brak zleceń. Dodaj pierwsze powyżej."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nazwa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Utworzono</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((o) => (
                <TableRow key={o.id}>
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
                  <TableCell className="space-x-2 text-right whitespace-nowrap">
                    <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => (setNotice(null), setEditing(o))}>
                      Edytuj
                    </Button>
                    {o.status === "OPEN" ? (
                      <>
                        <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => setStatus(o, "DONE")}>
                          Zakończ
                        </Button>
                        <Button type="button" variant="destructive" size="lg" disabled={busy} onClick={() => setStatus(o, "CANCELLED")}>
                          Anuluj
                        </Button>
                      </>
                    ) : (
                      <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => setStatus(o, "OPEN")}>
                        Otwórz ponownie
                      </Button>
                    )}
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

function OrderForm({
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
    const parsed = createOrderSchema.safeParse({ name: form.get("name"), notes: form.get("notes") });
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
            Nazwa nie musi być unikalna — przy wyborze zlecenia pokazujemy też datę utworzenia i notatkę.
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
