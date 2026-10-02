"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Field, NoticeBox, SELECT_CLASS, UnresolvedAttemptAlert } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { OrderSearch, SelectedOrder } from "@/components/order-search";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Notice } from "@/lib/api-client";
import { fetchLocationByCode, submitOperation, type IssuePayload, type TransferPayload } from "@/lib/stock-client";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import { orderSubLabel } from "@/lib/validation/orders";
import { parseScannedCode } from "@/lib/validation/locations";
import {
  ISSUE_REASONS,
  MIN_OVERRIDE_REASON_LENGTH,
  ISSUE_REASON_LABELS,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  checkQuantity,
  endSentence,
  formatQuantity,
  formatQuantityUnit,
  issueReasonLabel,
  type IssueReasonCode,
} from "@/lib/validation/stock";
import type { OrderDto } from "@/server/orders";
import type { MovementPage } from "@/server/stock";

type Tab = "ISSUE" | "TRANSFER";
type Filters = { q: string; from: string; to: string; orderId: string };

const DATE_TIME = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

function buildUrl(tab: Tab, f: Filters, page: number) {
  const params = new URLSearchParams();
  if (tab === "TRANSFER") params.set("typ", "przesuniecia");
  if (f.q) params.set("q", f.q);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (tab === "ISSUE" && f.orderId) params.set("zlecenie", f.orderId);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/wydania?${qs}` : "/wydania";
}


export function IssuesView({
  tab,
  page,
  filters,
  selectedOrder,
  canOperate,
}: {
  tab: Tab;
  page: MovementPage;
  filters: Filters;
  selectedOrder: OrderDto | null;
  canOperate: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [form, setForm] = useState<Tab | null>(null);

  useEffect(() => {
    if (q.trim() === filters.q) return;
    const timer = setTimeout(() => router.replace(buildUrl(tab, { ...filters, q: q.trim() }, 1)), 300);
    return () => clearTimeout(timer);
  }, [q, filters, tab, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const hasFilters = !!(filters.q || filters.from || filters.to || filters.orderId);
  const tabClass = (active: boolean) =>
    `rounded-md px-4 py-2 text-sm font-medium ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`;

  return (
    <div className="space-y-6">
      <nav className="flex gap-2" aria-label="Typ operacji">
        <Link href="/wydania" aria-current={tab === "ISSUE" ? "page" : undefined} className={tabClass(tab === "ISSUE")}>
          Wydania
        </Link>
        <Link
          href="/wydania?typ=przesuniecia"
          aria-current={tab === "TRANSFER" ? "page" : undefined}
          className={tabClass(tab === "TRANSFER")}
        >
          Przesunięcia
        </Link>
      </nav>

      {canOperate &&
        (form === "ISSUE" ? (
          <DesktopIssueForm onClose={() => setForm(null)} onSaved={() => router.refresh()} />
        ) : form === "TRANSFER" ? (
          <DesktopTransferForm onClose={() => setForm(null)} onSaved={() => router.refresh()} />
        ) : (
          <div className="flex gap-2">
            <Button type="button" onClick={() => setForm("ISSUE")}>
              Nowe wydanie
            </Button>
            <Button type="button" variant="outline" onClick={() => setForm("TRANSFER")}>
              Nowe przesunięcie
            </Button>
          </div>
        ))}

      <div className="flex flex-wrap items-end gap-4">
        <Input
          type="search"
          aria-label="Szukaj materiału"
          placeholder="Kod lub nazwa materiału"
          value={q}
          maxLength={MAX_SEARCH_LENGTH}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 w-72"
        />
        {tab === "ISSUE" && <OrderFilter tab={tab} filters={{ ...filters, q: q.trim() }} selected={selectedOrder} />}
        <label className="flex flex-col gap-1 text-sm">
          Od
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => router.replace(buildUrl(tab, { ...filters, q: q.trim(), from: e.target.value }, 1))}
            className={SELECT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Do
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => router.replace(buildUrl(tab, { ...filters, q: q.trim(), to: e.target.value }, 1))}
            className={SELECT_CLASS}
          />
        </label>
        {hasFilters && (
          <Button type="button" variant="outline" onClick={() => (setQ(""), router.replace(buildUrl(tab, { q: "", from: "", to: "", orderId: "" }, 1)))}>
            Wyczyść filtry
          </Button>
        )}
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {hasFilters ? "Brak operacji dla podanych filtrów." : tab === "ISSUE" ? "Brak wydań." : "Brak przesunięć."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Użytkownik</TableHead>
                <TableHead>Materiał</TableHead>
                <TableHead className="text-right">Ilość</TableHead>
                {tab === "ISSUE" ? (
                  <>
                    <TableHead>Lokalizacja</TableHead>
                    <TableHead>Zlecenie / powód</TableHead>
                  </>
                ) : (
                  <TableHead>Skąd → dokąd</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((m) => (
                <TableRow key={m.movementId}>
                  <TableCell className="whitespace-nowrap">{DATE_TIME.format(new Date(m.createdAt))}</TableCell>
                  <TableCell>{m.userName}</TableCell>
                  <TableCell>
                    <span className="font-mono">{m.materialCode}</span>
                    <div className="text-xs text-muted-foreground">{m.materialName}</div>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <span className="font-semibold">{formatQuantity(Math.abs(m.quantityDelta))}</span> {m.unit}
                    {m.reversedAt && (
                      <Link href={`/historia?operacja=${m.operationId}`} className="block text-xs text-rose-800 underline underline-offset-4">
                        cofnięto
                      </Link>
                    )}
                  </TableCell>
                  {tab === "ISSUE" ? (
                    <>
                      <TableCell className="font-mono">{m.locationCode}</TableCell>
                      <TableCell>
                        {m.productionOrderId ? (
                          <Link href={`/zlecenia/${m.productionOrderId}`} className="underline-offset-4 hover:underline">
                            {m.productionOrderName}
                          </Link>
                        ) : (
                          <span>
                            {issueReasonLabel(m.reasonCode)}
                            {m.reason && <span className="text-muted-foreground"> — {m.reason}</span>}
                          </span>
                        )}
                        {m.note && <div className="text-xs text-muted-foreground">{m.note}</div>}
                      </TableCell>
                    </>
                  ) : (
                    <TableCell className="font-mono whitespace-nowrap">
                      {m.fromLocationCode} → {m.toLocationCode}
                      {m.note && <div className="font-sans text-xs text-muted-foreground">{m.note}</div>}
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
          {page.total} poz. · strona {Math.min(page.page, totalPages)} z {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page <= 1}
            onClick={() => router.push(buildUrl(tab, filters, page.page - 1))}
          >
            Poprzednia
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page >= totalPages}
            onClick={() => router.push(buildUrl(tab, filters, page.page + 1))}
          >
            Następna
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Filtr „Zlecenie”: wyszukiwarka (wszystkie statusy) albo wybrane zlecenie z możliwością usunięcia filtra. */
function OrderFilter({ tab, filters, selected }: { tab: Tab; filters: Filters; selected: OrderDto | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const apply = (orderId: string) => router.replace(buildUrl(tab, { ...filters, orderId }, 1));
  return (
    <div className="flex w-80 flex-col gap-1 text-sm">
      <span>Zlecenie</span>
      {filters.orderId ? (
        selected ? (
          <SelectedOrder order={selected} onClear={() => apply("")} clearLabel="Wszystkie" />
        ) : (
          <Button type="button" variant="outline" onClick={() => apply("")}>
            Wybrane zlecenie — pokaż wszystkie
          </Button>
        )
      ) : open ? (
        <OrderSearch onSelect={(o) => (setOpen(false), apply(o.id))} label="Filtruj po zleceniu" />
      ) : (
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          wszystkie — wybierz zlecenie…
        </Button>
      )}
    </div>
  );
}

/** Wybrany materiał albo wyszukiwarka (formularze ADMIN-a). */
function MaterialField({
  material,
  locked,
  error,
  onChange,
  inStock,
}: {
  material: PickedMaterial | null;
  locked: boolean;
  error?: string;
  onChange: (m: PickedMaterial | null) => void;
  inStock?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">Materiał *</span>
      {material ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div>
            <span className="font-mono font-semibold">{material.code}</span> · {material.name}{" "}
            <span className="text-muted-foreground">({material.unit})</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            Zmień
          </Button>
        </div>
      ) : locked ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <MaterialPicker onSelect={onChange} size="md" inStock={inStock} />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

const okNotice = (text: string, replay: boolean): Notice => ({
  kind: "ok",
  text: endSentence(`${text}${replay ? " (operacja była już zapisana — bez duplikatu)" : ""}`),
});

/** Formularz wydania dla ADMIN-a — ten sam endpoint i ta sama ochrona przed duplikatem co terminal. */
function DesktopIssueForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"order" | "reason">("order");
  const [order, setOrder] = useState<OrderDto | null>(null);
  const [reasonCode, setReasonCode] = useState<IssueReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const att = useOperationAttempt<IssuePayload>();
  const [lookingUp, setLookingUp] = useState(false);
  const [sentLabel, setSentLabel] = useState<{ code: string; unit: string; locationCode: string; target: string } | null>(null);
  // Etap 11: RESERVED_STOCK → ADMIN może świadomie wydać mimo rezerwacji (powód, potwierdzenie z useConfirmGuard).
  const [blocked, setBlocked] = useState<{ payload: IssuePayload; label: NonNullable<typeof sentLabel> } | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const guard = useConfirmGuard();

  const locked = att.locked || lookingUp || overrideOpen;

  function resetOverride() {
    setBlocked(null);
    setOverrideOpen(false);
    setOverrideReason("");
  }

  async function send(payload: IssuePayload | null, label: NonNullable<typeof sentLabel>) {
    setSentLabel(label);
    setNotice(null);
    const res = await att.run(payload, (body) => submitOperation("ISSUE", body));
    if (!res) return;
    if (res.kind === "ok") {
      const overridden = (res.data.reservationsOverridden ?? []).reduce((sum, o) => sum + o.quantity, 0);
      setNotice(
        okNotice(
          `Wydano ${formatQuantityUnit(res.data.quantity, label.unit)} ${label.code} z ${label.locationCode} na ${label.target}. ` +
            `Zostało w lokalizacji: ${formatQuantityUnit(res.data.remainingLocationQuantity, label.unit)}` +
            (overridden > 0 ? `; zmniejszono rezerwacje innych zleceń o ${formatQuantityUnit(overridden, label.unit)}` : ""),
          res.data.idempotentReplay,
        ),
      );
      setSentLabel(null);
      setMaterial(null);
      setQty("");
      setNote("");
      resetOverride();
      onSaved();
    } else if (res.kind === "error") {
      setNotice({
        kind: "error",
        text:
          res.code === "INSUFFICIENT_STOCK" && res.available !== undefined
            ? `Niewystarczający stan w ${label.locationCode}. Dostępne: ${formatQuantityUnit(res.available, label.unit)}`
            : res.message,
      });
      if (res.code === "RESERVED_STOCK" && payload && !payload.override_reservations) setBlocked({ payload, label });
      else if (res.code !== "RESERVED_STOCK") resetOverride();
    }
  }

  async function confirmOverride(event: { detail: number }) {
    if (!guard.allow(event) || !blocked) return;
    const reason = overrideReason.trim();
    if (reason.length < MIN_OVERRIDE_REASON_LENGTH) return setErrors({ override: "Podaj powód (min. 3 znaki)" });
    setErrors({});
    await send({ ...blocked.payload, client_request_id: "", override_reservations: true, override_reason: reason }, blocked.label);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = att.current();
    if (current.status === "sending" || lookingUp) return;
    const retrying = current.status === "unknown" || current.status === "auth";

    let payload: IssuePayload | null = null;
    let label = sentLabel;
    if (!retrying) {
      const errs: Record<string, string> = {};
      if (mode === "order" && !order) errs.target = "Wybierz zlecenie";
      if (mode === "reason" && !reasonCode) errs.target = "Wybierz powód";
      if (mode === "reason" && reasonCode === "INNY" && !reasonText.trim()) errs.reason = "Opisz powód wydania";
      const code = parseScannedCode(locationCode);
      if (!code) errs.location = "Podaj poprawny kod lokalizacji";
      if (!material) errs.material = "Wybierz materiał";
      const q = checkQuantity(qty, material?.allowsFraction ?? true);
      if (!q.ok) errs.quantity = q.message;
      setErrors(errs);
      if (Object.keys(errs).length > 0 || !code || !material || !q.ok) return;
      setLookingUp(true);
      setNotice(null);
      // Wydanie z nieaktywnej lokalizacji jest dozwolone (ADR 010) — sprawdzamy tylko istnienie kodu.
      const loc = await fetchLocationByCode(code).finally(() => setLookingUp(false));
      if (loc.kind === "error") return setErrors({ location: loc.message });
      payload = {
        client_request_id: "",
        location_id: loc.data.id,
        material_id: material.id,
        quantity: q.value,
        production_order_id: mode === "order" && order ? order.id : null,
        reason_code: mode === "reason" ? reasonCode || null : null,
        reason: mode === "reason" ? reasonText.trim() || null : null,
        note: note.trim() || null,
      };
      label = {
        code: material.code,
        unit: material.unit,
        locationCode: loc.data.code,
        target:
          mode === "order" && order ? `zlecenie ${order.name} (${orderSubLabel(order, 40)})` : issueReasonLabel(reasonCode),
      };
    }
    if (!label || (!retrying && !payload)) return;
    if (!retrying) resetOverride();
    await send(payload, label);
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzone wydanie? Sprawdź na liście wydań, czy zostało zapisane.")) return;
    att.discard();
    setSentLabel(null);
    setNotice({ kind: "ok", text: "Porzucono. Sprawdź na liście wydań poniżej, czy operacja została zapisana." });
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nowe wydanie</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <NoticeBox notice={notice} />
        {att.unresolved && <UnresolvedAttemptAlert status={att.attempt.status} what="wydanie" listName="wydań" />}
        {blocked && !att.unresolved && !overrideOpen && (
          <Button type="button" variant="outline" className="border-amber-500 text-amber-900" onClick={() => (setOverrideOpen(true), guard.arm())}>
            Wydaj mimo rezerwacji…
          </Button>
        )}
        {blocked && overrideOpen && (
          <div role="alertdialog" aria-label="Wydanie mimo rezerwacji" className="space-y-3 rounded-lg border-2 border-amber-400 p-4">
            <p className="font-semibold">
              Wydać {formatQuantityUnit(blocked.payload.quantity, blocked.label.unit)} {blocked.label.code} z {blocked.label.locationCode} na{" "}
              {blocked.label.target} mimo rezerwacji innych zleceń?
            </p>
            <p className="text-sm text-muted-foreground">
              Brakująca część zostanie zabrana z rezerwacji innych zleceń (od najnowszej) i zapisana w historii z powodem.
            </p>
            <Field id="iss-override" label="Powód *" error={errors.override}>
              <Input
                id="iss-override"
                value={overrideReason}
                maxLength={MAX_REASON_LENGTH}
                onChange={(e) => setOverrideReason(e.target.value)}
                disabled={att.sending}
                autoComplete="off"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={(e) => void confirmOverride(e)} disabled={att.sending}>
                {att.sending ? "Zapisywanie…" : "Zatwierdź wydanie mimo rezerwacji"}
              </Button>
              <Button type="button" variant="outline" disabled={att.sending} onClick={resetOverride}>
                Anuluj
              </Button>
            </div>
          </div>
        )}
        <form onSubmit={submit} noValidate className="grid gap-4 lg:grid-cols-2">
          <fieldset disabled={locked} className="contents">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Na co? *</span>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="iss-mode" checked={mode === "order"} onChange={() => (setNotice(null), setMode("order"))} />
                    Zlecenie
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="iss-mode" checked={mode === "reason"} onChange={() => (setNotice(null), setMode("reason"))} />
                    Bez zlecenia (powód)
                  </label>
                </div>
                {mode === "order" ? (
                  order ? (
                    <SelectedOrder order={order} onClear={locked ? undefined : () => (setNotice(null), setOrder(null))} />
                  ) : (
                    <OrderSearch status="ISSUABLE" onSelect={(o) => (setNotice(null), setOrder(o))} label="Szukaj zlecenia do wydania" />
                  )
                ) : (
                  <select
                    aria-label="Powód"
                    value={reasonCode}
                    onChange={(e) => (setNotice(null), setReasonCode(e.target.value as IssueReasonCode | ""))}
                    className={`${SELECT_CLASS} w-full`}
                  >
                    <option value="">— wybierz powód —</option>
                    {ISSUE_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {ISSUE_REASON_LABELS[r]}
                      </option>
                    ))}
                  </select>
                )}
                {errors.target && <p className="text-xs text-destructive">{errors.target}</p>}
              </div>
              {mode === "reason" && (
                <Field id="iss-reason" label={`Opis powodu${reasonCode === "INNY" ? " *" : ""}`} error={errors.reason}>
                  <Input
                    id="iss-reason"
                    value={reasonText}
                    maxLength={MAX_REASON_LENGTH}
                    onChange={(e) => (setNotice(null), setReasonText(e.target.value))}
                    autoComplete="off"
                  />
                </Field>
              )}
              <Field id="iss-location" label="Lokalizacja (kod) *" error={errors.location}>
                <Input
                  id="iss-location"
                  value={locationCode}
                  onChange={(e) => (setNotice(null), setLocationCode(e.target.value))}
                  placeholder="np. A-03-02"
                  autoComplete="off"
                  className="font-mono uppercase"
                  aria-invalid={!!errors.location}
                />
              </Field>
            </div>
            <div className="space-y-4">
              <MaterialField
                material={material}
                locked={locked}
                error={errors.material}
                inStock
                onChange={(m) => (setNotice(null), setMaterial(m))}
              />
              <Field id="iss-qty" label={`Ilość *${material ? ` (${material.unit})` : ""}`} error={errors.quantity}>
                <Input
                  id="iss-qty"
                  value={qty}
                  onChange={(e) => (setNotice(null), setQty(e.target.value))}
                  inputMode={material?.allowsFraction === false ? "numeric" : "decimal"}
                  placeholder={material?.allowsFraction === false ? "liczba całkowita" : "np. 2,5"}
                  autoComplete="off"
                  aria-invalid={!!errors.quantity}
                />
              </Field>
              <Field id="iss-note" label="Notatka">
                <Input
                  id="iss-note"
                  value={note}
                  maxLength={MAX_NOTE_LENGTH}
                  onChange={(e) => (setNotice(null), setNote(e.target.value))}
                  autoComplete="off"
                />
              </Field>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button type="submit" disabled={att.sending || lookingUp}>
              {att.sending || lookingUp ? "Zapisywanie…" : att.unresolved ? "Ponów (ten sam id)" : "Wydaj"}
            </Button>
            {att.unresolved ? (
              <Button type="button" variant="outline" onClick={discard}>
                Porzuć — sprawdzę na liście wydań
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={att.sending || lookingUp} onClick={onClose}>
                Zamknij
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Formularz przesunięcia dla ADMIN-a — ten sam endpoint i ochrona przed duplikatem co terminal. */
function DesktopTransferForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [fromCode, setFromCode] = useState("");
  const [toCode, setToCode] = useState("");
  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const att = useOperationAttempt<TransferPayload>();
  const [lookingUp, setLookingUp] = useState(false);
  const [sentLabel, setSentLabel] = useState<{ code: string; unit: string; from: string; to: string } | null>(null);

  const locked = att.locked || lookingUp;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = att.current();
    if (current.status === "sending" || lookingUp) return;
    const retrying = current.status === "unknown" || current.status === "auth";

    let payload: TransferPayload | null = null;
    let label = sentLabel;
    if (!retrying) {
      const errs: Record<string, string> = {};
      const from = parseScannedCode(fromCode);
      const to = parseScannedCode(toCode);
      if (!from) errs.from = "Podaj poprawny kod lokalizacji";
      if (!to) errs.to = "Podaj poprawny kod lokalizacji";
      if (from && to && from === to) errs.to = "Lokalizacja docelowa musi być inna niż źródłowa";
      if (!material) errs.material = "Wybierz materiał";
      const q = checkQuantity(qty, material?.allowsFraction ?? true);
      if (!q.ok) errs.quantity = q.message;
      setErrors(errs);
      if (Object.keys(errs).length > 0 || !from || !to || !material || !q.ok) return;
      setLookingUp(true);
      setNotice(null);
      const [a, b] = await Promise.all([fetchLocationByCode(from), fetchLocationByCode(to)]).finally(() => setLookingUp(false));
      if (a.kind === "error" || b.kind === "error") {
        return setErrors({
          ...(a.kind === "error" ? { from: a.message } : {}),
          ...(b.kind === "error" ? { to: b.message } : {}),
        });
      }
      if (!b.data.active) return setErrors({ to: "Lokalizacja docelowa jest nieaktywna" });
      payload = {
        client_request_id: "",
        material_id: material.id,
        from_location_id: a.data.id,
        to_location_id: b.data.id,
        quantity: q.value,
        note: note.trim() || null,
      };
      label = { code: material.code, unit: material.unit, from: a.data.code, to: b.data.code };
    }
    if (!label || (!retrying && !payload)) return;

    setSentLabel(label);
    setNotice(null);
    const res = await att.run(payload, (body) => submitOperation("TRANSFER", body));
    if (!res) return;
    if (res.kind === "ok") {
      setNotice(
        okNotice(
          `Przesunięto ${formatQuantityUnit(res.data.quantity, label.unit)} ${label.code}: ${label.from} → ${label.to}. ` +
            `Stan ${label.from}: ${formatQuantityUnit(res.data.fromLocationQuantity, label.unit)}, ` +
            `${label.to}: ${formatQuantityUnit(res.data.toLocationQuantity, label.unit)}`,
          res.data.idempotentReplay,
        ),
      );
      setSentLabel(null);
      setMaterial(null);
      setQty("");
      setNote("");
      onSaved();
    } else if (res.kind === "error") {
      setNotice({ kind: "error", text: res.available !== undefined ? `Niewystarczający stan w ${label.from}. Dostępne: ${formatQuantityUnit(res.available, label.unit)}` : res.message });
    }
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzone przesunięcie? Sprawdź na liście przesunięć, czy zostało zapisane.")) return;
    att.discard();
    setSentLabel(null);
    setNotice({ kind: "ok", text: "Porzucono. Sprawdź na liście przesunięć, czy operacja została zapisana." });
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nowe przesunięcie</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <NoticeBox notice={notice} />
        {att.unresolved && <UnresolvedAttemptAlert status={att.attempt.status} what="przesunięcie" listName="przesunięć" />}
        <form onSubmit={submit} noValidate className="grid gap-4 lg:grid-cols-2">
          <fieldset disabled={locked} className="contents">
            <div className="space-y-4">
              <MaterialField
                material={material}
                locked={locked}
                error={errors.material}
                inStock
                onChange={(m) => (setNotice(null), setMaterial(m))}
              />
              <Field id="tr-qty" label={`Ilość *${material ? ` (${material.unit})` : ""}`} error={errors.quantity}>
                <Input
                  id="tr-qty"
                  value={qty}
                  onChange={(e) => (setNotice(null), setQty(e.target.value))}
                  inputMode={material?.allowsFraction === false ? "numeric" : "decimal"}
                  autoComplete="off"
                  aria-invalid={!!errors.quantity}
                />
              </Field>
            </div>
            <div className="space-y-4">
              <Field id="tr-from" label="Skąd (kod lokalizacji) *" error={errors.from}>
                <Input
                  id="tr-from"
                  value={fromCode}
                  onChange={(e) => (setNotice(null), setFromCode(e.target.value))}
                  autoComplete="off"
                  className="font-mono uppercase"
                  aria-invalid={!!errors.from}
                />
              </Field>
              <Field id="tr-to" label="Dokąd (kod lokalizacji) *" error={errors.to}>
                <Input
                  id="tr-to"
                  value={toCode}
                  onChange={(e) => (setNotice(null), setToCode(e.target.value))}
                  autoComplete="off"
                  className="font-mono uppercase"
                  aria-invalid={!!errors.to}
                />
              </Field>
              <Field id="tr-note" label="Notatka">
                <Input
                  id="tr-note"
                  value={note}
                  maxLength={MAX_NOTE_LENGTH}
                  onChange={(e) => (setNotice(null), setNote(e.target.value))}
                  autoComplete="off"
                />
              </Field>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button type="submit" disabled={att.sending || lookingUp}>
              {att.sending || lookingUp ? "Zapisywanie…" : att.unresolved ? "Ponów (ten sam id)" : "Przesuń"}
            </Button>
            {att.unresolved ? (
              <Button type="button" variant="outline" onClick={discard}>
                Porzuć — sprawdzę na liście przesunięć
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={att.sending || lookingUp} onClick={onClose}>
                Zamknij
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
