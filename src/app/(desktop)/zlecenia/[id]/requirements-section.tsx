"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Field, NoticeBox } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction } from "@/lib/api-client";
import { pluralPl } from "@/lib/format";
import { ISSUABLE_STATUSES, type OrderStatus } from "@/lib/validation/orders";
import {
  MAX_REQUIREMENT_ITEMS,
  MAX_REQUIREMENT_NAME_LENGTH,
  MAX_WITHDRAW_REASON_LENGTH,
  MIN_WITHDRAW_REASON_LENGTH,
  createRequirementSchema,
} from "@/lib/validation/requirements";
import { checkQuantity, formatQuantity } from "@/lib/validation/stock";
import type { RequirementDto } from "@/server/requirements";
import type { OrderReservationDto } from "@/server/reservations";
import { excessAfterWithdraw } from "@/lib/validation/reservations";



const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

type Row = { material: PickedMaterial; qtyText: string };
type Prefill = { name: string; rows: Row[] };

function prefillFrom(r: RequirementDto): Prefill {
  return {
    name: r.name,
    rows: r.items.map((i) => ({
      material: {
        id: i.materialId,
        code: i.materialCode,
        name: i.materialName,
        unit: i.unit,
        allowsFraction: i.allowsFraction,
        defaultSupplierId: null,
      },
      qtyText: formatQuantity(i.quantity),
    })),
  };
}

function ItemsTable({ r }: { r: RequirementDto }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Materiał</TableHead>
            <TableHead className="text-right">Ilość</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {r.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>
                <span className="font-mono">{i.materialCode}</span>
                <div className="text-xs text-muted-foreground">{i.materialName}</div>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <span className="font-semibold">{formatQuantity(i.quantity)}</span> {i.unit}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Sekcja „Zapotrzebowanie” zlecenia: listy ACTIVE (każda niezmienna; „Wycofaj” z powodem), listy WITHDRAWN
 * (zwinięte; „Utwórz poprawioną kopię”) i formularz nowej listy. Zapotrzebowanie zlecenia = suma list ACTIVE.
 */
export function RequirementsSection({
  orderId,
  orderStatus,
  requirements,
  canEdit,
  reservations = [],
}: {
  orderId: string;
  orderStatus: OrderStatus;
  requirements: RequirementDto[];
  canEdit: boolean;
  reservations?: OrderReservationDto[];
}) {
  const { run, busy, notice, setNotice } = useApiAction();
  const [form, setForm] = useState<{ key: number; prefill: Prefill | null } | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const keyRef = useRef(0);
  // Liczba wierszy w otwartym formularzu (L3: wycofanie nie może po cichu nadpisać wpisanych pozycji).
  const formRowsRef = useRef(0);

  const active = requirements.filter((r) => r.status === "ACTIVE");
  const withdrawn = requirements.filter((r) => r.status === "WITHDRAWN");
  const canAdd = canEdit && (ISSUABLE_STATUSES as readonly string[]).includes(orderStatus);

  function openForm(prefill: Prefill | null, keepNotice = false) {
    if (!keepNotice) setNotice(null);
    keyRef.current += 1;
    setForm({ key: keyRef.current, prefill });
  }

  async function withdraw(r: RequirementDto) {
    const text = reason.trim();
    if (text.length < MIN_WITHDRAW_REASON_LENGTH) return setReasonError(`Podaj powód (minimum ${MIN_WITHDRAW_REASON_LENGTH} znaki)`);
    const overwrite = canAdd && form !== null && formRowsRef.current > 0;
    const excess = excessAfterWithdraw(r, reservations);
    const question =
      `Wycofać listę „${r.name}”? Przestanie liczyć się do zapotrzebowania zlecenia.` +
      (excess.length > 0
        ? ` Zlecenie będzie miało rezerwacje ponad nowe zapotrzebowanie (${excess.join(", ")}) — rezerwacje NIE zmienią się same; po wycofaniu możesz użyć „Zwolnij nadmiar” w sekcji Rezerwacje.`
        : "") +
      (overwrite ? " Otwarty formularz z wpisanymi pozycjami zostanie zastąpiony poprawioną kopią tej listy." : "");
    if (!window.confirm(question)) return;
    setReasonError(null);
    const result = await run(
      () => callApi(`/api/v1/requirements/${r.id}/withdraw`, "POST", { reason: text }),
      `Wycofano listę „${r.name}”. Poniżej możesz utworzyć poprawioną kopię.`,
    );
    if (result?.ok) {
      setWithdrawing(null);
      setReason("");
      if (canAdd) openForm(prefillFrom(r), true);
    } else if (result) {
      setReasonError(result.message);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="req-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="req-title" className="text-lg font-semibold">
          Zapotrzebowanie
        </h2>
        {canAdd && !form && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => openForm(null)}>
              Dodaj listę
            </Button>
            <Link href={`/zlecenia/${orderId}/import`} className={buttonVariants({ variant: "outline" })}>
              Importuj z LiczOkno
            </Link>
          </div>
        )}
      </div>
      {!canAdd && canEdit && (
        <p className="text-sm text-muted-foreground">Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby dodać listę.</p>
      )}
      <NoticeBox notice={notice} />

      {form && (
        <RequirementForm
          key={form.key}
          orderId={orderId}
          prefill={form.prefill}
          onClose={() => setForm(null)}
          onRowsChange={(n) => (formRowsRef.current = n)}
          onSaved={(count, name) =>
            setNotice({ kind: "ok", text: `Dodano listę „${name}” (${count} ${pluralPl(count, "pozycja", "pozycje", "pozycji")})` })
          }
          run={run}
          busy={busy}
        />
      )}

      {active.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          Brak aktywnych list zapotrzebowania.{canAdd ? " Dodaj pierwszą." : ""}
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((r) => (
            <details key={r.id} className="rounded-xl border p-3" open={active.length === 1}>
              <summary className="cursor-pointer text-sm">
                <span className="font-semibold">{r.name}</span>{" "}
                {r.source === "IMPORT" && (
                  <span className="mr-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-900">Import LiczOkno</span>
                )}
                <span className="text-muted-foreground">
                  · {r.items.length} {pluralPl(r.items.length, "pozycja", "pozycje", "pozycji")} · {DATE.format(new Date(r.createdAt))}
                  {r.source === "IMPORT" && r.importedFileName && ` · plik: ${r.importedFileName}`}
                </span>
              </summary>
              <div className="mt-3 space-y-3">
                <ItemsTable r={r} />
                {canEdit &&
                  (withdrawing === r.id ? (
                    <div className="space-y-2 rounded-lg bg-muted/50 p-3">
                      <Field id={`wd-${r.id}`} label="Powód wycofania listy *" error={reasonError ?? undefined}>
                        <Input
                          id={`wd-${r.id}`}
                          value={reason}
                          maxLength={MAX_WITHDRAW_REASON_LENGTH}
                          onChange={(e) => (setReason(e.target.value), setReasonError(null))}
                          placeholder="np. zła ilość okien"
                          autoComplete="off"
                          aria-invalid={!!reasonError}
                        />
                      </Field>
                      <div className="flex gap-2">
                        <Button type="button" variant="destructive" disabled={busy} onClick={() => void withdraw(r)}>
                          Wycofaj listę
                        </Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => (setWithdrawing(null), setReason(""), setReasonError(null))}>
                          Anuluj
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => (setWithdrawing(r.id), setReason(""), setReasonError(null))}>
                      Wycofaj…
                    </Button>
                  ))}
              </div>
            </details>
          ))}
        </div>
      )}

      {withdrawn.length > 0 && (
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Wycofane listy ({withdrawn.length})</summary>
          <div className="mt-3 space-y-3">
            {withdrawn.map((r) => (
              <details key={r.id} className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm">
                  <span className="font-semibold line-through">{r.name}</span>{" "}
                  <span className="text-muted-foreground">
                    · wycofano {r.withdrawnAt ? DATE.format(new Date(r.withdrawnAt)) : ""} · powód: {r.withdrawReason}
                  </span>
                </summary>
                <div className="mt-3 space-y-3">
                  <ItemsTable r={r} />
                  {canAdd && (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => openForm(prefillFrom(r))}>
                      Utwórz poprawioną kopię
                    </Button>
                  )}
                </div>
              </details>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function RequirementForm({
  orderId,
  prefill,
  onClose,
  onRowsChange,
  onSaved,
  run,
  busy,
}: {
  orderId: string;
  prefill: Prefill | null;
  onClose: () => void;
  onRowsChange: (n: number) => void;
  onSaved: (itemCount: number, name: string) => void;
  run: ReturnType<typeof useApiAction>["run"];
  busy: boolean;
}) {
  const [name, setName] = useState(prefill ? `${prefill.name} (poprawiona)`.slice(0, MAX_REQUIREMENT_NAME_LENGTH) : "");
  const [rows, setRows] = useState<Row[]>(prefill?.rows ?? []);
  const [pending, setPending] = useState<PickedMaterial | null>(null);
  const [pendingQty, setPendingQty] = useState("");
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Identyfikator żądania (idempotencja): ten sam przy ponowieniu IDENTYCZNEJ listy (np. po błędzie sieci), nowy po zmianie.
  const sent = useRef<{ key: string; id: string } | null>(null);
  const rowsCount = rows.length;
  useEffect(() => {
    onRowsChange(rowsCount);
    return () => onRowsChange(0);
  }, [rowsCount, onRowsChange]);

  function addPending(event?: React.FormEvent) {
    event?.preventDefault();
    if (!pending) return;
    const check = checkQuantity(pendingQty, pending.allowsFraction);
    if (!check.ok) return setPendingError(check.message);
    const existing = rows.find((r) => r.material.id === pending.id);
    if (existing) {
      // Ten sam materiał wpisany drugi raz — sumujemy (lista ma materiał raz).
      const prev = checkQuantity(existing.qtyText, pending.allowsFraction);
      const sum = (prev.ok ? prev.value : 0) + check.value;
      const total = checkQuantity(Math.round(sum * 1000) / 1000, pending.allowsFraction);
      if (!total.ok) return setPendingError(total.message);
      setRows(rows.map((r) => (r === existing ? { ...r, qtyText: formatQuantity(total.value) } : r)));
      setInfo(`${pending.code}: dodano do istniejącej pozycji — razem ${formatQuantity(total.value)} ${pending.unit}.`);
    } else {
      if (rows.length >= MAX_REQUIREMENT_ITEMS) return setPendingError(`Lista może mieć maksymalnie ${MAX_REQUIREMENT_ITEMS} pozycji`);
      setRows([...rows, { material: pending, qtyText: formatQuantity(check.value) }]);
      setInfo(null);
    }
    setPending(null);
    setPendingQty("");
    setPendingError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // M4: wybrany materiał z wpisaną ilością nie może zostać po cichu pominięty.
    if (pending && pendingQty.trim() !== "") {
      return setErrors({ _: "Dodaj pozycję (przycisk „Dodaj do listy”) albo zmień materiał — wpisana ilość nie jest jeszcze na liście." });
    }
    const next: Record<string, string> = {};
    const items = rows.map((r, i) => {
      const check = checkQuantity(r.qtyText, r.material.allowsFraction);
      if (!check.ok) next[`row-${i}`] = check.message;
      return { material_id: r.material.id, quantity: check.ok ? check.value : 0 };
    });
    if (Object.keys(next).length > 0) return setErrors(next);
    const key = JSON.stringify({ name: name.trim(), items });
    if (!sent.current || sent.current.key !== key) sent.current = { key, id: crypto.randomUUID() };
    const parsed = createRequirementSchema.safeParse({ name, items, client_request_id: sent.current.id });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setErrors({ [first.path[0] === "name" ? "name" : "_"]: first.message });
      return;
    }
    setErrors({});
    const result = await run(
      () => callApi(`/api/v1/orders/${orderId}/requirements`, "POST", parsed.data),
      "Zapisano listę",
    );
    if (result?.ok) {
      // Liczba pozycji z odpowiedzi serwera (nie z formularza).
      const count = Number((result.data as { itemCount?: number } | undefined)?.itemCount ?? parsed.data.items.length);
      onSaved(count, parsed.data.name);
      onClose();
    }
    else if (result) setErrors({ _: result.message });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{prefill ? "Poprawiona kopia listy" : "Nowa lista zapotrzebowania"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="req-name" label="Nazwa listy (np. „Okna parter”) *" error={errors.name}>
          <Input
            id="req-name"
            value={name}
            maxLength={MAX_REQUIREMENT_NAME_LENGTH}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            aria-invalid={!!errors.name}
            className="max-w-md"
          />
        </Field>

        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Dodaj pozycję</p>
          {pending ? (
            <form onSubmit={addPending} noValidate className="flex flex-wrap items-end gap-3">
              <div className="min-w-48">
                <div className="font-mono text-sm font-bold">{pending.code}</div>
                <div className="text-xs text-muted-foreground">{pending.name}</div>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Ilość
                <span className="flex items-center gap-2">
                  <Input
                    value={pendingQty}
                    onChange={(e) => (setPendingQty(e.target.value), setPendingError(null))}
                    inputMode="decimal"
                    autoFocus
                    aria-label={`Ilość ${pending.code}`}
                    aria-invalid={!!pendingError}
                    className="h-9 w-28"
                  />
                  <span className="text-sm text-muted-foreground">{pending.unit}</span>
                </span>
              </label>
              <Button type="submit">Dodaj do listy</Button>
              <Button type="button" variant="outline" onClick={() => (setPending(null), setPendingQty(""), setPendingError(null))}>
                Zmień materiał
              </Button>
              {pendingError && (
                <p role="alert" className="w-full text-sm text-destructive">
                  {pendingError}
                </p>
              )}
            </form>
          ) : (
            <MaterialPicker size="md" onSelect={(m) => (setPending(m), setPendingQty(""), setPendingError(null), setInfo(null))} />
          )}
          {info && (
            <p role="status" className="text-sm text-muted-foreground">
              {info}
            </p>
          )}
        </div>

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Materiał</TableHead>
                  <TableHead className="text-right">Ilość</TableHead>
                  <TableHead className="text-right">Akcje</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={r.material.id}>
                    <TableCell>
                      <span className="font-mono">{r.material.code}</span>
                      <div className="text-xs text-muted-foreground">{r.material.name}</div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        <Input
                          value={r.qtyText}
                          inputMode="decimal"
                          aria-label={`Ilość ${r.material.code}`}
                          aria-invalid={!!errors[`row-${i}`]}
                          onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qtyText: e.target.value } : x)))}
                          className="h-9 w-28 text-right"
                        />
                        {r.material.unit}
                      </span>
                      {errors[`row-${i}`] && <div className="text-xs text-destructive">{errors[`row-${i}`]}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button type="button" variant="outline" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        Usuń
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          Podsumowanie: {rows.length} {pluralPl(rows.length, "pozycja", "pozycje", "pozycji")}. Lista po zapisaniu jest niezmienna — błąd
          poprawia się przez wycofanie i poprawioną kopię.
        </p>
        {errors._ && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {errors._}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || rows.length === 0} onClick={submit}>
            Zapisz listę
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Anuluj
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
