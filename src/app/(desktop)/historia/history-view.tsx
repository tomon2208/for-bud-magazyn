"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Field, NoticeBox, SELECT_CLASS, UnresolvedAttemptAlert } from "@/components/form-parts";
import { OrderSearch, SelectedOrder } from "@/components/order-search";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDelta } from "@/lib/adjustment";
import type { Notice } from "@/lib/api-client";
import { submitReversal, type ReversalPayload } from "@/lib/stock-client";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import {
  HISTORY_TYPES,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MIN_REVERSAL_REASON_LENGTH,
  OPERATION_TYPE_LABELS,
  endSentence,
  formatQuantity,
  formatQuantityUnit,
  reasonLabel,
  type OperationType,
} from "@/lib/validation/stock";
import type { OrderDto } from "@/server/orders";
import type { MovementDto, MovementPage, StockDiscrepancyDto, UserNameDto } from "@/server/stock";

export type HistoryFilters = {
  type: string;
  q: string;
  materialId: string;
  location: string;
  userId: string;
  orderId: string;
  operationId: string;
  from: string;
  to: string;
};
const EMPTY: HistoryFilters = { type: "", q: "", materialId: "", location: "", userId: "", orderId: "", operationId: "", from: "", to: "" };

const DATE_TIME = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const fmt = (iso: string) => DATE_TIME.format(new Date(iso));

const TYPE_BADGE: Record<string, string> = {
  RECEIPT: "bg-emerald-100 text-emerald-900",
  ISSUE: "bg-sky-100 text-sky-900",
  TRANSFER: "bg-violet-100 text-violet-900",
  ADJUSTMENT: "bg-amber-100 text-amber-900",
  REVERSAL: "bg-rose-100 text-rose-900",
  INVENTORY: "bg-teal-100 text-teal-900",
};
const typeLabel = (t: string | null) => (t && t in OPERATION_TYPE_LABELS ? OPERATION_TYPE_LABELS[t as OperationType] : (t ?? ""));

export function buildHistoryUrl(f: HistoryFilters, page = 1) {
  const params = new URLSearchParams();
  if (f.type) params.set("typ", f.type);
  if (f.q) params.set("q", f.q);
  if (f.materialId) params.set("material", f.materialId);
  if (f.location) params.set("lokalizacja", f.location);
  if (f.userId) params.set("uzytkownik", f.userId);
  if (f.orderId) params.set("zlecenie", f.orderId);
  if (f.operationId) params.set("operacja", f.operationId);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/historia?${qs}` : "/historia";
}

/** Przesunięcie i storno przesunięcia są pokazywane jako jeden wiersz „skąd → dokąd”. */
const isTransferRow = (m: MovementDto) => m.fromLocationCode !== null && m.toLocationCode !== null;

export function HistoryView({
  page,
  filters,
  users,
  selectedOrder,
  selectedMaterial,
  unknownLocation,
  isAdmin,
}: {
  page: MovementPage;
  filters: HistoryFilters;
  users: UserNameDto[];
  selectedOrder: OrderDto | null;
  selectedMaterial: { code: string; name: string } | null;
  unknownLocation: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [loc, setLoc] = useState(filters.location);
  const [reversing, setReversing] = useState<MovementDto | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const go = (patch: Partial<HistoryFilters>) => router.replace(buildHistoryUrl({ ...filters, q: q.trim(), ...patch }, 1));

  useEffect(() => {
    if (q.trim() === filters.q) return;
    const timer = setTimeout(() => router.replace(buildHistoryUrl({ ...filters, q: q.trim() }, 1)), 300);
    return () => clearTimeout(timer);
  }, [q, filters, router]);

  useEffect(() => {
    if (reversing) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [reversing]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-6">
      {isAdmin && <VerifyPanel />}

      {isAdmin && reversing && (
        <div ref={panelRef}>
          <ReversePanel
            key={reversing.operationId}
            row={reversing}
            onClose={() => setReversing(null)}
            onDone={() => router.refresh()}
          />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Typ
          <select value={filters.type} onChange={(e) => go({ type: e.target.value })} className={SELECT_CLASS}>
            <option value="">wszystkie</option>
            {HISTORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {OPERATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Materiał
          {filters.materialId ? (
            <span className="flex h-9 items-center gap-2 rounded-lg border px-2">
              <span className="font-mono">{selectedMaterial?.code ?? "wybrany"}</span>
              <button type="button" className="underline underline-offset-4" onClick={() => go({ materialId: "" })}>
                wszystkie
              </button>
            </span>
          ) : (
            <Input
              type="search"
              placeholder="Kod lub nazwa"
              value={q}
              maxLength={MAX_SEARCH_LENGTH}
              onChange={(e) => setQ(e.target.value)}
              className="h-9 w-56"
            />
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Lokalizacja (kod)
          <Input
            value={loc}
            onChange={(e) => setLoc(e.target.value)}
            onBlur={() => loc.trim().toUpperCase() !== filters.location && go({ location: loc.trim().toUpperCase() })}
            onKeyDown={(e) => e.key === "Enter" && go({ location: loc.trim().toUpperCase() })}
            placeholder="np. A-03-02"
            maxLength={40}
            className="h-9 w-36 font-mono uppercase"
            aria-invalid={unknownLocation}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Użytkownik
          <select value={filters.userId} onChange={(e) => go({ userId: e.target.value })} className={`${SELECT_CLASS} w-48`}>
            <option value="">wszyscy</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
                {u.active ? "" : " (nieaktywny)"}
              </option>
            ))}
          </select>
        </label>
        <OrderFilter filters={{ ...filters, q: q.trim() }} selected={selectedOrder} />
        <label className="flex flex-col gap-1 text-sm">
          Od
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => go({ from: e.target.value })} className={SELECT_CLASS} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Do
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => go({ to: e.target.value })} className={SELECT_CLASS} />
        </label>
        {hasFilters && (
          <Button type="button" variant="outline" onClick={() => (setQ(""), setLoc(""), router.replace(buildHistoryUrl(EMPTY)))}>
            Wyczyść filtry
          </Button>
        )}
      </div>

      {unknownLocation && (
        <p role="alert" className="text-sm text-destructive">
          Nieznany kod lokalizacji: {filters.location.slice(0, 40)}
        </p>
      )}
      {filters.operationId && (
        <p className="flex flex-wrap items-center gap-3 rounded-md bg-muted p-3 text-sm">
          Pokazano wybraną operację i jej cofnięcie.
          <button type="button" className="underline underline-offset-4" onClick={() => go({ operationId: "" })}>
            Pokaż całą historię
          </button>
        </p>
      )}

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {hasFilters ? "Brak ruchów dla podanych filtrów." : "Brak ruchów magazynowych."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Typ</TableHead>
                <TableHead>Materiał</TableHead>
                <TableHead>Lokalizacja</TableHead>
                <TableHead className="text-right">Ilość</TableHead>
                <TableHead>Użytkownik</TableHead>
                <TableHead>Szczegóły</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((m) => (
                <TableRow key={m.movementId} className={m.reversedAt ? "text-muted-foreground" : undefined}>
                  <TableCell className="whitespace-nowrap">{fmt(m.createdAt)}</TableCell>
                  <TableCell>
                    <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap ${TYPE_BADGE[m.type] ?? "bg-muted"}`}>
                      {typeLabel(m.type)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono">{m.materialCode}</span>
                    <div className="text-xs text-muted-foreground">{m.materialName}</div>
                  </TableCell>
                  <TableCell className="font-mono whitespace-nowrap">
                    {isTransferRow(m) ? `${m.fromLocationCode} → ${m.toLocationCode}` : m.locationCode}
                  </TableCell>
                  <TableCell className="text-right font-semibold whitespace-nowrap">
                    {isTransferRow(m) ? formatQuantityUnit(Math.abs(m.quantityDelta), m.unit) : formatDelta(m.quantityDelta, m.unit)}
                  </TableCell>
                  <TableCell>{m.userName}</TableCell>
                  <TableCell className="max-w-72">
                    <Details m={m} />
                  </TableCell>
                  <TableCell className="max-w-64 text-xs">
                    <Status m={m} />
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      {m.reversible && (
                        <Button type="button" variant="outline" size="sm" onClick={() => setReversing(m)}>
                          Cofnij
                        </Button>
                      )}
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
          <Button type="button" variant="outline" size="lg" disabled={page.page <= 1} onClick={() => router.push(buildHistoryUrl(filters, page.page - 1))}>
            Poprzednia
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page >= totalPages}
            onClick={() => router.push(buildHistoryUrl(filters, page.page + 1))}
          >
            Następna
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Zlecenie / powód / dostawca / dokument + notatka. */
function Details({ m }: { m: MovementDto }) {
  const order = m.productionOrderId ? (
    <Link href={`/zlecenia/${m.productionOrderId}`} className="underline-offset-4 hover:underline">
      Zlecenie: {m.productionOrderName}
    </Link>
  ) : null;
  let main: React.ReactNode = null;
  if (m.type === "RECEIPT") {
    main = [m.supplierName && `Dostawca: ${m.supplierName}`, m.documentRef && `Dok.: ${m.documentRef}`].filter(Boolean).join(" · ") || null;
  } else if (m.type === "ISSUE") {
    main = order ?? (
      <span>
        {reasonLabel(m.type, m.reasonCode)}
        {m.reason && <span className="text-muted-foreground"> — {m.reason}</span>}
      </span>
    );
  } else if (m.type === "ADJUSTMENT") {
    main = (
      <span>
        Powód: {reasonLabel(m.type, m.reasonCode)}
        {m.reason && <span className="text-muted-foreground"> — {m.reason}</span>}
      </span>
    );
  } else if (m.type === "REVERSAL") {
    main = (
      <span>
        Powód cofnięcia: {m.reason}
        {order && <div>{order}</div>}
      </span>
    );
  } else if (m.type === "INVENTORY" && m.inventorySessionId) {
    main = (
      <Link href={`/inwentaryzacja/${m.inventorySessionId}`} className="underline-offset-4 hover:underline">
        Sesja: {m.inventorySessionName}
      </Link>
    );
  }
  return (
    <div className="text-sm">
      {main}
      {m.note && <div className="text-xs text-muted-foreground">Notatka: {m.note}</div>}
    </div>
  );
}

function Status({ m }: { m: MovementDto }) {
  if (m.reversedAt && m.reversedByOperationId) {
    return (
      <span className="text-rose-800">
        Cofnięto {fmt(m.reversedAt)}, {m.reversedByUserName}
        {m.reversedReason && <> — {m.reversedReason}</>}{" "}
        <Link href={buildHistoryUrl({ ...EMPTY, operationId: m.operationId })} className="underline underline-offset-4">
          pokaż
        </Link>
      </span>
    );
  }
  if (m.reversesOperationId) {
    return (
      <span>
        Cofa: {typeLabel(m.reversesType).toLowerCase()}
        {m.reversesCreatedAt && <> z {fmt(m.reversesCreatedAt)}</>}{" "}
        <Link href={buildHistoryUrl({ ...EMPTY, operationId: m.reversesOperationId })} className="underline underline-offset-4">
          pokaż
        </Link>
      </span>
    );
  }
  return null;
}

/** Filtr „Zlecenie”: wyszukiwarka (wszystkie statusy) albo wybrane zlecenie. */
function OrderFilter({ filters, selected }: { filters: HistoryFilters; selected: OrderDto | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const apply = (orderId: string) => router.replace(buildHistoryUrl({ ...filters, orderId }, 1));
  return (
    <div className="flex w-72 flex-col gap-1 text-sm">
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

/** Opis operacji do potwierdzenia cofnięcia. */
function describeOperation(m: MovementDto): string {
  const qty = formatQuantityUnit(Math.abs(m.quantityDelta), m.unit);
  const where = isTransferRow(m) ? `${m.fromLocationCode} → ${m.toLocationCode}` : m.locationCode;
  return `${typeLabel(m.type)} z ${fmt(m.createdAt)}: ${m.materialCode}, ${m.quantityDelta < 0 && !isTransferRow(m) ? "−" : ""}${qty}, ${where} (${m.userName})`;
}

/** Skutek cofnięcia (ruchy odwrotne) — do potwierdzenia. */
function describeEffect(m: MovementDto): string {
  const qty = formatQuantity(Math.abs(m.quantityDelta));
  if (isTransferRow(m)) return endSentence(`Towar wróci: ${m.toLocationCode} → ${m.fromLocationCode} (${qty} ${m.unit})`);
  return endSentence(
    m.quantityDelta > 0
      ? `Stan w ${m.locationCode} zmniejszy się o ${qty} ${m.unit}`
      : `Stan w ${m.locationCode} zwiększy się o ${qty} ${m.unit}${m.productionOrderName ? `; wydanie na zlecenie ${m.productionOrderName} zostanie pomniejszone` : ""}`,
  );
}

/** Cofnięcie operacji (ADMIN): powód → potwierdzenie → storno; ochrona przed duplikatem jak w innych formularzach. */
function ReversePanel({ row, onClose, onDone }: { row: MovementDto; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const att = useOperationAttempt<ReversalPayload>();
  const guard = useConfirmGuard();

  function review() {
    setNotice(null);
    if (reason.trim().length < MIN_REVERSAL_REASON_LENGTH) {
      setError(`Podaj powód cofnięcia (co najmniej ${MIN_REVERSAL_REASON_LENGTH} znaki)`);
      return;
    }
    setError(null);
    guard.arm();
    setConfirming(true);
  }

  async function confirm() {
    const cur = att.current();
    if (cur.status === "sending") return;
    const payload: ReversalPayload = { client_request_id: "", operation_id: row.operationId, reason: reason.trim(), note: note.trim() || null };
    const res = await att.run(payload, submitReversal);
    if (!res) return;
    if (res.kind === "ok") {
      setDone(true);
      setConfirming(false);
      setNotice({
        kind: "ok",
        text: endSentence(`Cofnięto operację (${typeLabel(row.type).toLowerCase()} ${row.materialCode})${res.data.idempotentReplay ? " — była już cofnięta tym żądaniem, bez duplikatu" : ""}`),
      });
      onDone();
    } else if (res.kind === "error") {
      setConfirming(false);
      setNotice({ kind: "error", text: res.message });
      if (res.code === "ALREADY_REVERSED") onDone();
    }
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzone cofnięcie? Sprawdź w historii, czy zostało zapisane.")) return;
    att.discard();
    setConfirming(false);
    setNotice({ kind: "ok", text: "Porzucono. Sprawdź w historii, czy cofnięcie zostało zapisane." });
    onDone();
  }

  const locked = att.locked || confirming || done;

  return (
    <Card className="border-rose-300">
      <CardHeader>
        <CardTitle>Cofnij operację</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{describeOperation(row)}</p>
        <p className="text-sm text-muted-foreground">
          {describeEffect(row)} Powstanie nowa operacja „Cofnięcie” z ruchami odwrotnymi; oryginał zostanie w historii oznaczony
          jako cofnięty.
        </p>
        <NoticeBox notice={notice} />
        {att.unresolved && <UnresolvedAttemptAlert status={att.attempt.status} what="cofnięcie" listName="historii" />}
        {!done && (
          <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
            <Field id="rev-reason" label="Powód cofnięcia *" error={error ?? undefined}>
              <Input id="rev-reason" value={reason} maxLength={MAX_REASON_LENGTH} onChange={(e) => (setNotice(null), setReason(e.target.value))} autoComplete="off" autoFocus />
            </Field>
            <Field id="rev-note" label="Notatka">
              <Input id="rev-note" value={note} maxLength={MAX_NOTE_LENGTH} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
            </Field>
          </fieldset>
        )}
        {confirming && !att.unresolved && !done && (
          // Osobny blok potwierdzenia (nie w miejscu „Dalej”) + guard: dwuklik „Dalej” nie wykona storna (review M1).
          <div role="alertdialog" aria-label="Potwierdź cofnięcie" className="space-y-3 rounded-lg border-2 border-rose-400 p-4">
            <p className="font-semibold">Na pewno cofnąć tę operację?</p>
            <p className="text-sm">Powód: {reason.trim()}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={(e) => guard.allow(e) && void confirm()}
                disabled={att.sending}
              >
                {att.sending ? "Zapisywanie…" : "Tak, cofnij operację"}
              </Button>
              <Button type="button" variant="outline" disabled={att.sending} onClick={() => setConfirming(false)}>
                Wróć
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {done ? (
            <Button type="button" variant="outline" onClick={onClose}>
              Zamknij
            </Button>
          ) : att.unresolved ? (
            <>
              <Button type="button" onClick={() => void confirm()} disabled={att.sending}>
                {att.sending ? "Zapisywanie…" : "Ponów (ten sam id)"}
              </Button>
              <Button type="button" variant="outline" onClick={discard}>
                Porzuć — sprawdzę w historii
              </Button>
            </>
          ) : confirming ? null : (
            <>
              <Button type="button" onClick={review}>
                Dalej — potwierdź
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>
                Anuluj
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type VerifyState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; checkedAt: string; discrepancies: StockDiscrepancyDto[] }
  | { kind: "error"; message: string };

/** Kontrola spójności (ADMIN): stany bieżące vs suma ruchów (verify_stock). */
function VerifyPanel() {
  const [state, setState] = useState<VerifyState>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/v1/stock/verify");
      const json = (await res.json().catch(() => null)) as {
        data?: { checkedAt: string; discrepancies: StockDiscrepancyDto[] };
        error?: { message?: string };
      } | null;
      if (res.ok && json?.data) setState({ kind: "ok", ...json.data });
      else setState({ kind: "error", message: json?.error?.message ?? `Błąd (${res.status})` });
    } catch {
      setState({ kind: "error", message: "Brak połączenia z serwerem" });
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => void run()} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Sprawdzanie…" : "Sprawdź spójność stanów"}
        </Button>
        <span className="text-sm text-muted-foreground">Porównuje stany bieżące z sumą wszystkich ruchów w historii.</span>
      </div>
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {state.kind === "ok" &&
        (state.discrepancies.length === 0 ? (
          <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
            OK — 0 rozbieżności (sprawdzono {fmt(state.checkedAt)}).
          </p>
        ) : (
          <div role="alert" className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-semibold">Rozbieżności: {state.discrepancies.length}. Zgłoś to — stan nie zgadza się z historią.</p>
            <ul className="list-disc pl-5">
              {state.discrepancies.slice(0, 50).map((d) => (
                <li key={`${d.materialId}:${d.locationId}`}>
                  {d.materialCode ?? d.materialId} w {d.locationCode ?? d.locationId}: stan {formatQuantity(d.stockQuantity)}, historia{" "}
                  {formatQuantity(d.ledgerQuantity)}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
