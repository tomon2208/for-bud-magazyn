"use client";

import { useEffect, useState, type FormEvent } from "react";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IssueTarget, PendingLocation, PendingOperation } from "@/lib/pending-operation";
import { fetchStock, type IssueResponse, type StockRow } from "@/lib/stock-client";
import { StockRows } from "../stock-rows";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import {
  ISSUE_REASONS,
  ISSUE_REASON_LABELS,
  MAX_REASON_LENGTH,
  checkQuantity,
  formatQuantity,
  formatQuantityUnit,
  type IssueReasonCode,
} from "@/lib/validation/stock";
import { orderSubLabel } from "@/lib/validation/orders";
import type { OrderDto } from "@/server/orders";
import { CodeScanner } from "../code-scanner";
import { useOperationSubmit, type SubmitError } from "../use-operation-submit";
import {
  BIG_PRIMARY,
  BIG_ROW,
  BIG_SECONDARY,
  ContextRow,
  FinishLink,
  QuantityInput,
  ResumeScreen,
  SubmitErrorAlert,
  WizardHeader,
} from "../wizard-parts";

type Step = "target" | "reason" | "material" | "location" | "quantity" | "summary" | "done";
type PendingIssue = PendingOperation<"ISSUE">;

function targetLabel(t: IssueTarget): string {
  return t.kind === "order" ? `zlecenie ${t.name}` : `${t.label}${t.text ? ` — ${t.text}` : ""}`;
}

export function IssueWizard({
  userId,
  presetLocation,
  presetMessage,
  recentOrders,
  openOrders,
  openOrdersTotal,
  recentMaterials,
}: {
  userId: string;
  presetLocation: PendingLocation | null;
  presetMessage: string | null;
  recentOrders: OrderDto[];
  openOrders: OrderDto[];
  openOrdersTotal: number;
  recentMaterials: PickedMaterial[];
}) {
  const [step, setStep] = useState<Step>("target");
  const [target, setTarget] = useState<IssueTarget | null>(null);
  const [reasonCode, setReasonCode] = useState<IssueReasonCode | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [location, setLocation] = useState<PendingLocation | null>(presetLocation);
  const [available, setAvailable] = useState<number>(0);
  const [qtyText, setQtyText] = useState("");
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);

  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<IssueResponse | null>(null);
  const [usedOrders, setUsedOrders] = useState(recentOrders);
  const op = useOperationSubmit("ISSUE", userId);

  // Numeracja kroków: na co → materiał → (lokalizacja) → ilość → podsumowanie.
  const total = presetLocation ? 4 : 5;
  const stepNo: Record<Step, number> = presetLocation
    ? { target: 1, reason: 1, material: 2, location: 2, quantity: 3, summary: 4, done: 4 }
    : { target: 1, reason: 1, material: 2, location: 3, quantity: 4, summary: 5, done: 5 };

  function chooseOrder(o: OrderDto) {
    // Nazwy zleceń mogą się powtarzać — w kontekście, podsumowaniu i wyniku pokazujemy też datę i notatkę.
    setTarget({ kind: "order", id: o.id, name: o.name, sub: orderSubLabel(o) });
    setStep("material");
  }

  function chooseReason(code: IssueReasonCode) {
    if (code === "INNY") {
      setReasonCode(code);
      setReasonError(null);
      return;
    }
    setTarget({ kind: "reason", code, label: ISSUE_REASON_LABELS[code], text: null });
    setStep("material");
  }

  function confirmOther(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reasonText.trim();
    if (!text) return setReasonError("Opisz powód wydania");
    if (text.length > MAX_REASON_LENGTH) return setReasonError(`Opis może mieć maksymalnie ${MAX_REASON_LENGTH} znaków`);
    setTarget({ kind: "reason", code: "INNY", label: ISSUE_REASON_LABELS.INNY, text });
    setStep("material");
  }

  /** Materiał z wyszukiwarki (bez ustalonej lokalizacji) → krok wyboru lokalizacji. */
  function pickMaterial(m: PickedMaterial) {
    setMaterial(m);
    setLocation(null);
    setStep("location");
  }

  /** Wiersz stanu (materiał w lokalizacji) → krok ilości z dostępną ilością. */
  function pickStockRow(row: StockRow) {
    setMaterial({
      id: row.materialId,
      code: row.materialCode,
      name: row.materialName,
      unit: row.unit,
      allowsFraction: row.allowsFraction,
      defaultSupplierId: null,
    });
    setLocation({ id: row.locationId, code: row.locationCode, name: row.locationName });
    setAvailable(row.quantity);
    setQtyText("");
    setQtyError(null);
    setStep("quantity");
  }

  function goSummary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!material) return;
    const check = checkQuantity(qtyText, material.allowsFraction);
    if (!check.ok) return setQtyError(check.message);
    // Blokada po stronie klienta — źródłem prawdy jest serwer (INSUFFICIENT_STOCK).
    if (check.value > available) {
      return setQtyError(`Za dużo — dostępne tylko ${formatQuantityUnit(available, material.unit)}`);
    }
    setQuantity(check.value);
    setRequestId(crypto.randomUUID());
    op.clearError();
    setStep("summary");
  }

  /** INSUFFICIENT_STOCK: od razu aktualna dostępność z serwera i komunikat z jednostką. */
  function onDomainError(p: PendingIssue) {
    return (e: SubmitError): SubmitError => {
      if (e.code !== "INSUFFICIENT_STOCK" || e.available === undefined) return e;
      setAvailable(e.available);
      return {
        ...e,
        message: `Niewystarczający stan w ${p.ctx.location.code}. Dostępne: ${formatQuantityUnit(e.available, p.ctx.material.unit)}`,
      };
    };
  }

  async function send(p: PendingIssue) {
    const data = await op.send(p, onDomainError(p));
    if (!data) return;
    setResult(data);
    const t = p.ctx.target;
    if (t.kind === "order") {
      const used = openOrders.find((o) => o.id === t.id) ?? usedOrders.find((o) => o.id === t.id);
      if (used) setUsedOrders((list) => [used, ...list.filter((o) => o.id !== used.id)].slice(0, 5));
    }
    setStep("done");
  }

  function confirm() {
    if (!target || !material || !location || !requestId || quantity === null) return;
    void send({
      v: 2,
      kind: "ISSUE",
      userId,
      requestId,
      payload: {
        client_request_id: requestId,
        location_id: location.id,
        material_id: material.id,
        quantity,
        production_order_id: target.kind === "order" ? target.id : null,
        reason_code: target.kind === "reason" ? target.code : null,
        reason: target.kind === "reason" ? target.text : null,
        note: null,
      },
      ctx: { location, material, target },
      savedAt: Date.now(),
    });
  }

  function resume(p: PendingIssue) {
    setTarget(p.ctx.target);
    setMaterial(p.ctx.material);
    setLocation(p.ctx.location);
    setQuantity(p.payload.quantity);
    setQtyText(formatQuantity(p.payload.quantity));
    setRequestId(p.requestId);
    setResult(null);
    setStep("summary");
    // Dostępność nie jest zapisana w storage — pobieramy aktualną (potrzebna, gdy trzeba poprawić ilość).
    void fetchStock({ materialId: p.ctx.material.id, locationId: p.ctx.location.id }).then((r) => {
      if (r.kind === "ok") setAvailable(r.items[0]?.quantity ?? 0);
    });
    void send(p);
  }

  function discardPending() {
    if (!op.discard("Porzucić niepotwierdzone wydanie? Sprawdź w „Moich ostatnich operacjach”, czy zostało zapisane.")) {
      return;
    }
    setRequestId(null);
    setMaterial(null);
    setLocation(presetLocation);
    setResult(null);
    setStep(target ? "material" : "target");
  }

  /**
   * Po błędzie domenowym wracamy do właściwego kroku: zamknięte/nieistniejące zlecenie → wybór zlecenia,
   * nieistniejący materiał/lokalizacja (np. po wznowieniu) → wybór materiału, pozostałe (ilość) → ilość.
   */
  function fixAfterError() {
    const err = op.error;
    op.clearError();
    if (err?.code === "ORDER_NOT_OPEN" || (err?.code === "NOT_FOUND" && target?.kind === "order")) {
      setTarget(null);
      setStep("target");
      return;
    }
    if (err?.code === "NOT_FOUND" || err?.code === "IDEMPOTENCY_CONFLICT") {
      setMaterial(null);
      setLocation(presetLocation);
      setStep("material");
      return;
    }
    if (err?.code === "INSUFFICIENT_STOCK" && err.available !== undefined) setAvailable(err.available);
    setStep("quantity");
  }

  const fixLabel =
    op.error?.code === "ORDER_NOT_OPEN" || (op.error?.code === "NOT_FOUND" && target?.kind === "order")
      ? "Wybierz inne zlecenie"
      : op.error?.code === "NOT_FOUND" || op.error?.code === "IDEMPOTENCY_CONFLICT"
        ? "Wybierz ponownie materiał"
        : "Popraw ilość";

  function nextMaterial() {
    setMaterial(null);
    setLocation(presetLocation);
    setResult(null);
    setRequestId(null);
    op.clearError();
    setStep("material");
  }

  function changeTarget() {
    setTarget(null);
    setReasonCode(null);
    setStep("target");
  }

  if (op.showResume && op.pending) {
    const p = op.pending;
    return (
      <ResumeScreen title="Wydanie" what="wydanie" onResume={() => resume(p)} onDiscard={discardPending}>
        <p className="font-mono text-4xl font-extrabold break-all">{formatQuantityUnit(p.payload.quantity, p.ctx.material.unit)}</p>
        <p className="mt-1 text-xl font-semibold break-all">{p.ctx.material.code}</p>
        <p className="text-base text-muted-foreground">{p.ctx.material.name}</p>
        <p className="mt-2 text-lg">
          z <span className="font-mono text-2xl font-bold">{p.ctx.location.code}</span>
        </p>
        <p className="mt-2 text-lg break-words">na: {targetLabel(p.ctx.target)}</p>
        {p.ctx.target.kind === "order" && p.ctx.target.sub && (
          <p className="text-sm break-words text-muted-foreground">{p.ctx.target.sub}</p>
        )}
      </ResumeScreen>
    );
  }

  const frozen = step === "summary" && op.locked;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <WizardHeader title="Wydanie" step={stepNo[step]} total={total} locked={op.locked} />

      {presetMessage && step === "target" && (
        <p role="alert" className="rounded-xl bg-amber-100 p-4 text-base font-medium text-amber-900">
          {presetMessage} Lokalizację wybierzesz po materiale.
        </p>
      )}

      {target && step !== "target" && step !== "reason" && step !== "done" && (
        <ContextRow
          label={target.kind === "order" ? "Zlecenie" : "Bez zlecenia — powód"}
          value={target.kind === "order" ? target.name : target.label}
          sub={target.kind === "reason" ? target.text : (target.sub ?? null)}
          mono={false}
          onChange={frozen ? undefined : changeTarget}
        />
      )}
      {presetLocation && step === "material" && (
        <ContextRow label="Lokalizacja" value={presetLocation.code} sub={presetLocation.name} />
      )}
      {material && (step === "location" || step === "quantity" || step === "summary") && (
        <ContextRow
          label="Materiał"
          value={material.code}
          sub={`${material.name} · ${material.unit}`}
          onChange={frozen ? undefined : () => (setLocation(presetLocation), setStep("material"))}
        />
      )}
      {location && material && (step === "quantity" || step === "summary") && (
        <ContextRow
          label="Lokalizacja"
          value={location.code}
          sub={`dostępne: ${formatQuantityUnit(available, material.unit)}`}
          onChange={frozen || presetLocation ? undefined : () => setStep("location")}
        />
      )}

      {step === "target" && (
        <>
          <h2 className="text-2xl font-bold">Na co wydajesz?</h2>
          <OrderPicker recent={usedOrders} initial={openOrders} initialTotal={openOrdersTotal} onSelect={chooseOrder} />
          <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => (setReasonCode(null), setStep("reason"))}>
            Bez zlecenia (serwis, uszkodzenie…)
          </Button>
        </>
      )}

      {step === "reason" && (
        <>
          <h2 className="text-2xl font-bold">Powód wydania</h2>
          {reasonCode !== "INNY" ? (
            <ul className="flex flex-col gap-2">
              {ISSUE_REASONS.map((code) => (
                <li key={code}>
                  <button type="button" className={`${BIG_ROW} text-xl font-semibold`} onClick={() => chooseReason(code)}>
                    {ISSUE_REASON_LABELS[code]}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form onSubmit={confirmOther} noValidate className="flex flex-col gap-3">
              <label htmlFor="reason-text" className="text-lg font-semibold">
                Opisz powód (wymagane)
              </label>
              <textarea
                id="reason-text"
                value={reasonText}
                onChange={(e) => (setReasonText(e.target.value), setReasonError(null))}
                maxLength={MAX_REASON_LENGTH}
                rows={3}
                autoFocus
                aria-invalid={!!reasonError}
                className="w-full rounded-xl border border-input bg-background px-4 py-3 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              {reasonError && (
                <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
                  {reasonError}
                </p>
              )}
              <Button type="submit" className={BIG_PRIMARY}>
                Dalej
              </Button>
              <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => setReasonCode(null)}>
                Inny powód z listy
              </Button>
            </form>
          )}
          <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => setStep("target")}>
            Wróć do zleceń
          </Button>
        </>
      )}

      {step === "material" && (
        <>
          <h2 className="text-2xl font-bold">Wybierz materiał</h2>
          {presetLocation ? (
            <StockRows
              key={`loc-${presetLocation.id}`}
              filter={{ locationId: presetLocation.id }}
              emptyText="Lokalizacja jest pusta — nie ma czego wydać."
              show="material"
              onSelect={pickStockRow}
            />
          ) : (
            <MaterialPicker onSelect={pickMaterial} recent={recentMaterials} recentLabel="Ostatnio wydawane" inStock />
          )}
        </>
      )}

      {step === "location" && material && (
        <LocationStep material={material} onSelect={pickStockRow} />
      )}

      {step === "quantity" && material && location && (
        <form onSubmit={goSummary} noValidate className="flex flex-col gap-4">
          <label htmlFor="qty" className="text-2xl font-bold">
            Ilość <span className="text-lg font-medium text-muted-foreground">(dostępne: {formatQuantityUnit(available, material.unit)})</span>
          </label>
          <QuantityInput
            value={qtyText}
            onChange={(v) => (setQtyText(v), setQtyError(null))}
            unit={material.unit}
            allowsFraction={material.allowsFraction}
            error={qtyError}
          />
          <Button type="submit" className={BIG_PRIMARY}>
            Dalej
          </Button>
        </form>
      )}

      {step === "summary" && target && location && material && (
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border bg-background p-5 text-center">
            <p className="text-lg text-muted-foreground">Wydajesz</p>
            <p className="my-1 font-mono text-5xl font-extrabold break-all">
              {formatQuantity(quantity ?? 0)}
              <span className="ml-2 text-3xl font-bold">{material.unit}</span>
            </p>
            <p className="text-xl font-semibold break-all">{material.code}</p>
            <p className="text-base text-muted-foreground">{material.name}</p>
            <p className="mt-3 text-lg">
              z <span className="font-mono text-2xl font-bold">{location.code}</span>
            </p>
            <p className="mt-2 text-lg break-words">
              na: <span className="font-bold">{targetLabel(target)}</span>
            </p>
            {target.kind === "order" && target.sub && (
              <p className="text-sm break-words text-muted-foreground">{target.sub}</p>
            )}
          </section>

          {op.error && <SubmitErrorAlert error={op.error} menuLabel="WYDANIE" />}

          <Button
            type="button"
            className={BIG_PRIMARY}
            disabled={op.submitting || op.error?.kind === "domain"}
            onClick={() => (op.unresolved && op.pending ? void send(op.pending) : confirm())}
          >
            {op.submitting ? "Zapisywanie…" : op.unresolved ? "Spróbuj ponownie" : "ZATWIERDŹ"}
          </Button>
          {op.unresolved ? (
            <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={op.submitting} onClick={discardPending}>
              Porzuć — sprawdzę w ostatnich operacjach
            </Button>
          ) : (
            <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={op.submitting} onClick={fixAfterError}>
              {fixLabel}
            </Button>
          )}
        </div>
      )}

      {step === "done" && result && target && location && material && (
        <div className="flex flex-col gap-4">
          <section role="status" className="rounded-2xl bg-emerald-100 p-5 text-center text-emerald-950">
            <p className="text-2xl font-bold">Wydano {formatQuantityUnit(result.quantity, material.unit)}</p>
            <p className="mt-1 text-lg break-all">
              {material.code} — {material.name}
            </p>
            <p className="mt-1 text-lg">
              z <span className="font-mono font-bold">{location.code}</span> na {targetLabel(target)}
            </p>
            {target.kind === "order" && target.sub && <p className="text-sm break-words">{target.sub}</p>}
            <p className="mt-3 text-xl">
              Zostało w lokalizacji:{" "}
              <span className="font-bold">{formatQuantityUnit(result.remainingLocationQuantity, material.unit)}</span>
            </p>
            {result.idempotentReplay && (
              <p className="mt-2 text-base">Ta operacja była już zapisana — nie została zdublowana.</p>
            )}
          </section>
          <Button type="button" className={BIG_PRIMARY} onClick={nextMaterial}>
            {target.kind === "order" ? "Kolejny materiał na to zlecenie" : "Kolejny materiał (ten sam powód)"}
          </Button>
          <FinishLink />
        </div>
      )}
    </div>
  );
}

/** Lista otwartych zleceń: ostatnio używane na górze, wyszukiwanie po nazwie (nazwy mogą się powtarzać — data i notatka). */
function OrderPicker({
  recent,
  initial,
  initialTotal,
  onSelect,
}: {
  recent: OrderDto[];
  initial: OrderDto[];
  initialTotal: number;
  onSelect: (o: OrderDto) => void;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "ok"; items: OrderDto[]; total: number } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const term = q.trim();

  useEffect(() => {
    if (term === "") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const params = new URLSearchParams({ status: "OPEN", q: term, pageSize: "30" });
        const res = await fetch(`/api/v1/orders?${params}`, { signal: controller.signal });
        const json = (await res.json().catch(() => null)) as {
          data?: { items: OrderDto[]; total: number };
          error?: { message?: string };
        } | null;
        if (!res.ok || !json?.data) return setState({ kind: "error", message: json?.error?.message ?? `Błąd (${res.status})` });
        setState({ kind: "ok", items: json.data.items, total: json.data.total });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setState({ kind: "error", message: "Brak połączenia z serwerem" });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const row = (o: OrderDto) => (
    <li key={o.id}>
      <button type="button" className={BIG_ROW} onClick={() => onSelect(o)}>
        <span className="text-xl font-bold break-words">{o.name}</span>
        <span className="text-sm break-words text-muted-foreground">{orderSubLabel(o)}</span>
      </button>
    </li>
  );

  const recentIds = new Set(recent.map((o) => o.id));
  const rest = initial.filter((o) => !recentIds.has(o.id));

  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        aria-label="Szukaj zlecenia"
        placeholder="Szukaj zlecenia (np. nazwisko)"
        value={q}
        maxLength={MAX_SEARCH_LENGTH}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        enterKeyHint="search"
        className="h-14 rounded-xl px-4 text-xl"
      />
      {term === "" ? (
        <>
          {recent.length > 0 && (
            <>
              <p className="text-base font-semibold text-muted-foreground">Ostatnio używane</p>
              <ul className="flex flex-col gap-2">{recent.map(row)}</ul>
            </>
          )}
          {rest.length > 0 && (
            <>
              <p className="text-base font-semibold text-muted-foreground">Otwarte zlecenia (najnowsze)</p>
              <ul className="flex flex-col gap-2">{rest.map(row)}</ul>
            </>
          )}
          {recent.length === 0 && initial.length === 0 && (
            <p className="rounded-xl border bg-background p-4 text-center text-muted-foreground">Brak otwartych zleceń.</p>
          )}
          {initialTotal > initial.length && (
            <p className="text-center text-sm text-muted-foreground">Pokazano {initial.length} z {initialTotal}. Wyszukaj po nazwie.</p>
          )}
        </>
      ) : state.kind === "loading" || state.kind === "idle" ? (
        <p className="text-muted-foreground">Szukanie…</p>
      ) : state.kind === "error" ? (
        <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-destructive">
          {state.message}
        </p>
      ) : state.items.length === 0 ? (
        <p className="rounded-xl border bg-background p-4 text-center text-muted-foreground">Brak otwartych zleceń dla tej frazy.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">{state.items.map(row)}</ul>
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

/** Krok lokalizacji przy wydaniu: lista miejsc, w których materiał jest (tapnięcie) albo skan QR. */
function LocationStep({ material, onSelect }: { material: PickedMaterial; onSelect: (row: StockRow) => void }) {
  const [mode, setMode] = useState<"list" | "scan">("list");
  const [scanKey, setScanKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function onScanned(code: string) {
    setChecking(true);
    setMessage(null);
    const r = await fetchStock({ materialId: material.id });
    setChecking(false);
    if (r.kind === "error") {
      setMessage(r.message);
      setScanKey((k) => k + 1);
      return;
    }
    const row = r.items.find((i) => i.locationCode === code);
    if (!row) {
      setMessage(`W lokalizacji ${code} nie ma materiału ${material.code}. Zeskanuj inną albo wybierz z listy.`);
      setScanKey((k) => k + 1);
      return;
    }
    onSelect(row);
  }

  return (
    <>
      <h2 className="text-2xl font-bold">Skąd wydajesz?</h2>
      {mode === "list" ? (
        <>
          <StockRows
            filter={{ materialId: material.id }}
            emptyText={`Materiału ${material.code} nie ma na stanie w żadnej lokalizacji.`}
            show="location"
            onSelect={onSelect}
          />
          <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => setMode("scan")}>
            Zeskanuj lokalizację
          </Button>
        </>
      ) : (
        <>
          {checking && <p className="rounded-xl bg-muted p-4 text-lg">Sprawdzanie…</p>}
          <CodeScanner key={scanKey} onCode={onScanned} message={message} submitLabel="Dalej" />
          <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => (setMode("list"), setMessage(null))}>
            Wybierz z listy
          </Button>
        </>
      )}
    </>
  );
}
