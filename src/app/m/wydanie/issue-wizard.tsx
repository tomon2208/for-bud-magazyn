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
import { ORDER_STATUS_LABELS, orderSubLabel } from "@/lib/validation/orders";
import type { OrderDto } from "@/server/orders";
import { issueLimit, suggestQuantityForRow } from "@/lib/to-issue";
import {
  defaultSubstituteChoice,
  substituteCandidates,
  substituteQuantityError,
  type SubstituteOption,
} from "@/lib/substitutes";
import { MIN_OVERRIDE_REASON_LENGTH } from "@/lib/validation/stock";
import type { MaterialAvailabilityDto } from "@/server/reservations";
import type { ToIssueDto } from "@/server/requirements";
import { CodeScanner } from "../code-scanner";
import { useConfirmGuard } from "@/lib/confirm-guard";
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
/** Etap 12b: wydanie zamiennika — oryginał z zapotrzebowania + dane do podpowiedzi ilości (z chwili tapnięcia). */
type SubstituteFor = { id: string; code: string; name: string; remaining: number; subAvailable: number; allowsFraction: boolean };
/** Etap 12b (H1): podpowiedź w podsumowaniu — kandydaci „Policz jako zamiennik za XXX”; selected "" = zwykłe wydanie. */
type Candidate = { id: string; code: string; name: string; remaining: number; unit: string; allowsFraction: boolean };
/** loading / error — lista „do wydania” jeszcze nieznana; nie przechodzimy po cichu jako zwykłe wydanie. */
type SubChoice =
  | { status: "ok"; candidates: Candidate[]; selected: string }
  | { status: "loading" }
  | { status: "error"; message: string };

function buildSubChoice(items: ToIssueDto[], materialId: string, qty: number): SubChoice | null {
  const cands: Candidate[] = substituteCandidates(items, materialId).map((c) => ({
    id: c.materialId,
    code: c.materialCode,
    name: c.materialName,
    remaining: c.remaining,
    unit: c.unit,
    allowsFraction: c.allowsFraction,
  }));
  return cands.length > 0 ? { status: "ok", candidates: cands, selected: defaultSubstituteChoice(cands, qty) } : null;
}
type PendingIssue = PendingOperation<"ISSUE">;

function targetLabel(t: IssueTarget): string {
  return t.kind === "order" ? `zlecenie ${t.name}` : `${t.label}${t.text ? ` — ${t.text}` : ""}`;
}

/** Dostępność materiału z rezerwacjami (Etap 11) dla wybranego celu wydania; null — jeszcze nie wiadomo. */
type Availability = { materialId: string; orderId: string | null; data: MaterialAvailabilityDto | null; failed: boolean } | null;

async function fetchAvailability(materialId: string, orderId: string | null): Promise<MaterialAvailabilityDto | null> {
  try {
    const params = new URLSearchParams({ materialId, ...(orderId ? { orderId } : {}) });
    const res = await fetch(`/api/v1/stock/availability?${params}`);
    const json = (await res.json().catch(() => null)) as { data?: MaterialAvailabilityDto } | null;
    return res.ok && json?.data ? json.data : null;
  } catch {
    return null;
  }
}

export function IssueWizard({
  userId,
  isAdmin = false,
  presetLocation,
  presetMessage,
  recentOrders,
  openOrders,
  openOrdersTotal,
  recentMaterials,
}: {
  userId: string;
  isAdmin?: boolean;
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
  // Etap 11: wolne / rezerwacja zlecenia; wydanie ADMIN-a mimo rezerwacji (z powodem).
  const [avail, setAvail] = useState<Availability>(null);
  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [substituteFor, setSubstituteFor] = useState<SubstituteFor | null>(null);
  const [subChoice, setSubChoice] = useState<SubChoice | null>(null);

  // „Do wydania na to zlecenie” (zapotrzebowanie: pozostało > 0) — ładowane przy kroku wyboru materiału.
  const toIssue = useToIssue(target?.kind === "order" ? target.id : null, step === "material");
  const [toIssueMessage, setToIssueMessage] = useState<string | null>(null);

  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<IssueResponse | null>(null);
  const [usedOrders, setUsedOrders] = useState(recentOrders);
  const op = useOperationSubmit("ISSUE", userId);
  const guard = useConfirmGuard();

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

  function loadAvailability(materialId: string, t: IssueTarget | null) {
    const orderId = t?.kind === "order" ? t.id : null;
    setAvail(null);
    void fetchAvailability(materialId, orderId).then((data) => {
      setAvail({ materialId, orderId, data, failed: data === null });
    });
  }
  // Aktualne tylko dla bieżącego materiału i celu.
  const availForCurrent =
    avail && material && avail.materialId === material.id && avail.orderId === (target?.kind === "order" ? target.id : null)
      ? avail
      : null;
  const currentAvail = availForCurrent?.data ?? null;

  /** Materiał z wyszukiwarki (bez ustalonej lokalizacji) → krok wyboru lokalizacji. */
  function pickMaterial(m: PickedMaterial) {
    setMaterial(m);
    setLocation(null);
    setStep("location");
  }

  /** Wiersz stanu (materiał w lokalizacji) → krok ilości z dostępną ilością. */
  function pickStockRow(row: StockRow, sub: SubstituteFor | null) {
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
    setOverrideMode(false);
    loadAvailability(row.materialId, target);
    // Materiał z zapotrzebowania zlecenia: podpowiedź ilości = min(pozostało, dostępne w tej lokalizacji).
    // Tylko ze świeżych danych (po wydaniu stary wynik jest unieważniany do czasu nowej odpowiedzi).
    // Zamiennik (Etap 12b): min(pozostało oryginału, dostępne zamiennika dla zlecenia, w lokalizacji).
    // Dane zamiennika przekazane parametrem (L3) — nie z domknięcia sprzed setState.
    const suggested = suggestQuantityForRow(toIssue, row, sub);
    setQtyText(suggested === null ? "" : formatQuantity(suggested));
    setQtyError(null);
    setStep("quantity");
  }

  /** Tapnięcie pozycji z „Do wydania na to zlecenie”: materiał wybrany, dalej lokalizacja (albo ilość przy ustalonej lokalizacji). */
  async function pickPlanned(item: ToIssueDto) {
    setSubstituteFor(null);
    await pickKnown(null, {
      id: item.materialId,
      code: item.materialCode,
      name: item.materialName,
      unit: item.unit,
      allowsFraction: item.allowsFraction,
      defaultSupplierId: null,
    });
  }

  /** Etap 12b: tapnięcie „Odpowiednik YYY” przy pozycji XXX — wydanie YYY jako zamiennika za XXX. */
  async function pickSubstitute(item: ToIssueDto, sub: SubstituteOption) {
    const chosen: SubstituteFor = {
      id: item.materialId,
      code: item.materialCode,
      name: item.materialName,
      remaining: item.remaining,
      subAvailable: sub.available,
      allowsFraction: item.allowsFraction,
    };
    setSubstituteFor(chosen);
    await pickKnown(chosen, { id: sub.materialId, code: sub.code, name: sub.name, unit: sub.unit, allowsFraction: sub.allowsFraction, defaultSupplierId: null });
  }

  /** Materiał znany z listy „Do wydania”: dalej lokalizacja (albo ilość przy ustalonej lokalizacji). */
  async function pickKnown(sub: SubstituteFor | null, m: PickedMaterial) {
    setToIssueMessage(null);
    if (presetLocation) {
      const r = await fetchStock({ materialId: m.id, locationId: presetLocation.id });
      if (r.kind === "error") return setToIssueMessage(r.message);
      const row = r.items.find((i) => i.locationId === presetLocation.id && i.quantity > 0);
      if (!row) return setToIssueMessage(`W lokalizacji ${presetLocation.code} nie ma materiału ${m.code}.`);
      return pickStockRow(row, sub);
    }
    pickMaterial(m);
  }

  function goSummary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!material) return;
    const check = checkQuantity(qtyText, material.allowsFraction);
    if (!check.ok) return setQtyError(check.message);
    // Blokada po stronie klienta — źródłem prawdy jest serwer (INSUFFICIENT_STOCK / RESERVED_STOCK).
    if (check.value > available) {
      return setQtyError(`Za dużo — dostępne tylko ${formatQuantityUnit(available, material.unit)}`);
    }
    const limit = issueLimit(available, currentAvail ? currentAvail.availableForIssue : null);
    const reservedBlock = check.value > limit;
    if (reservedBlock && !isAdmin) {
      return setQtyError(
        `Za dużo — można wydać ${formatQuantityUnit(limit, material.unit)} (reszta jest zarezerwowana dla innych zleceń)`,
      );
    }
    // Zamiennik wskazany w „Do wydania”: ilość dopuszczalna także dla oryginału (baza: NOT_INTEGER z kodem XXX).
    if (substituteFor && substituteFor.id !== material.id) {
      const subErr = substituteQuantityError(check.value, substituteFor);
      if (subErr) return setQtyError(subErr);
    }
    // ADMIN: świadome wydanie mimo rezerwacji — podsumowanie wymaga powodu.
    setOverrideMode(reservedBlock);
    setOverrideReason("");
    // H1: materiał bez „pozostało” na zleceniu, a odpowiednik ma — widoczny wybór (domyślnie największe pozostało).
    if (target?.kind === "order" && !substituteFor) {
      if (toIssue.kind === "ok") setSubChoice(buildSubChoice(toIssue.items, material.id, check.value));
      else void loadSubChoice(target.id, material.id, check.value);
    } else {
      setSubChoice(null);
    }
    setQuantity(check.value);
    setRequestId(crypto.randomUUID());
    op.clearError();
    guard.arm();
    setStep("summary");
  }

  /** Lista „do wydania” nieznana (wczytywanie / błąd) — dociągamy ją przed podsumowaniem (bez cichego zwykłego wydania). */
  async function loadSubChoice(orderId: string, materialId: string, qty: number) {
    setSubChoice({ status: "loading" });
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/to-issue`);
      const json = (await res.json().catch(() => null)) as { data?: ToIssueDto[]; error?: { message?: string } } | null;
      if (!res.ok || !json?.data) {
        return setSubChoice({ status: "error", message: json?.error?.message ?? `Błąd (${res.status})` });
      }
      setSubChoice(buildSubChoice(json.data, materialId, qty));
    } catch {
      setSubChoice({ status: "error", message: "Brak połączenia z serwerem" });
    }
  }

  /** RESERVED_STOCK (ADMIN): przejście w tryb „wydaj mimo rezerwacji” — nowy identyfikator, wymagany powód. */
  function startOverride() {
    op.clearError();
    setOverrideMode(true);
    setOverrideReason("");
    setRequestId(crypto.randomUUID());
    guard.arm();
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

  // Zamiennik wysyłany do bazy: wskazany w „Do wydania” albo wybrany w podsumowaniu (H1 — zawsze jawnie).
  const chosenCandidate = subChoice?.status === "ok" ? (subChoice.candidates.find((c) => c.id === subChoice.selected) ?? null) : null;
  const subPending = !substituteFor && (subChoice?.status === "loading" || subChoice?.status === "error");
  const effectiveSub = substituteFor
    ? { id: substituteFor.id, code: substituteFor.code, name: substituteFor.name }
    : chosenCandidate
      ? { id: chosenCandidate.id, code: chosenCandidate.code, name: chosenCandidate.name }
      : null;

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
        ...(overrideMode ? { override_reservations: true, override_reason: overrideReason.trim() } : {}),
        ...(effectiveSub && target.kind === "order" ? { substitute_for: effectiveSub.id } : {}),
      },
      ctx: {
        location,
        material,
        target,
        ...(effectiveSub && target.kind === "order" ? { substituteFor: effectiveSub } : {}),
      },
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
    setOverrideMode(p.payload.override_reservations === true);
    setOverrideReason(p.payload.override_reason ?? "");
    setSubstituteFor(p.ctx.substituteFor ? { ...p.ctx.substituteFor, remaining: 0, subAvailable: 0, allowsFraction: true } : null);
    setSubChoice(null);
    loadAvailability(p.ctx.material.id, p.ctx.target);
    guard.arm();
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
    if (
      err?.code === "NOT_FOUND" ||
      err?.code === "IDEMPOTENCY_CONFLICT" ||
      err?.code === "NOT_A_SUBSTITUTE" ||
      err?.code === "NOT_IN_REQUIREMENTS"
    ) {
      setSubstituteFor(null);
      setMaterial(null);
      setLocation(presetLocation);
      setStep("material");
      return;
    }
    if (err?.code === "INSUFFICIENT_STOCK" && err.available !== undefined) setAvailable(err.available);
    if (material) loadAvailability(material.id, target);
    setOverrideMode(false);
    setStep("quantity");
  }

  const fixLabel =
    op.error?.code === "ORDER_NOT_OPEN" || (op.error?.code === "NOT_FOUND" && target?.kind === "order")
      ? "Wybierz inne zlecenie"
      : op.error?.code === "NOT_FOUND" ||
          op.error?.code === "IDEMPOTENCY_CONFLICT" ||
          op.error?.code === "NOT_A_SUBSTITUTE" ||
          op.error?.code === "NOT_IN_REQUIREMENTS"
        ? "Wybierz ponownie materiał"
        : "Popraw ilość";

  function nextMaterial() {
    setOverrideMode(false);
    setSubstituteFor(null);
    setSubChoice(null);
    setMaterial(null);
    setLocation(presetLocation);
    setResult(null);
    setRequestId(null);
    op.clearError();
    setStep("material");
  }

  function changeTarget() {
    setOverrideMode(false);
    setSubstituteFor(null);
    setSubChoice(null);
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
        {p.ctx.substituteFor && (
          <p className="mt-2 text-base font-semibold text-amber-900">Zamiennik za {p.ctx.substituteFor.code}</p>
        )}
        {p.payload.override_reservations && (
          <p className="mt-2 text-base font-semibold text-amber-900">Mimo rezerwacji — powód: {p.payload.override_reason}</p>
        )}
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
          label={substituteFor && substituteFor.id !== material.id ? `Materiał — zamiennik za ${substituteFor.code}` : "Materiał"}
          value={material.code}
          sub={`${material.name} · ${material.unit}`}
          onChange={frozen ? undefined : () => (setSubstituteFor(null), setLocation(presetLocation), setStep("material"))}
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
          {target?.kind === "order" && (
            <ToIssueList
              state={toIssue}
              message={toIssueMessage}
              onSelect={(i) => void pickPlanned(i)}
              onSubstitute={(i, sub) => void pickSubstitute(i, sub)}
            />
          )}
          {presetLocation ? (
            <StockRows
              key={`loc-${presetLocation.id}`}
              filter={{ locationId: presetLocation.id }}
              emptyText="Lokalizacja jest pusta — nie ma czego wydać."
              show="material"
              onSelect={(row) => (setSubstituteFor(null), pickStockRow(row, null))}
            />
          ) : (
            <MaterialPicker
              onSelect={(m) => (setSubstituteFor(null), pickMaterial(m))}
              recent={recentMaterials}
              recentLabel="Ostatnio wydawane"
              inStock
            />
          )}
        </>
      )}

      {step === "location" && material && (
        <LocationStep material={material} onSelect={(row) => pickStockRow(row, substituteFor)} />
      )}

      {step === "quantity" && material && location && (
        <form onSubmit={goSummary} noValidate className="flex flex-col gap-4">
          <label htmlFor="qty" className="text-2xl font-bold">
            Ilość <span className="text-lg font-medium text-muted-foreground">(w lokalizacji: {formatQuantityUnit(available, material.unit)})</span>
          </label>
          <ReservationInfo
            avail={currentAvail}
            failed={availForCurrent?.failed === true}
            onRetry={() => loadAvailability(material.id, target)}
            unit={material.unit}
            forOrder={target?.kind === "order"}
          />
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
            {effectiveSub && effectiveSub.id !== material.id && (
              <p className="mt-2 rounded-xl bg-amber-100 px-3 py-2 text-lg font-bold text-amber-950">
                Zamiennik za {effectiveSub.code}
                <span className="block text-sm font-normal">{effectiveSub.name}</span>
              </p>
            )}
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

          {subChoice?.status === "loading" && !substituteFor && (
            <p className="rounded-xl bg-muted p-3 text-base">Sprawdzanie, czy materiał jest odpowiednikiem pozycji zlecenia…</p>
          )}
          {subChoice?.status === "error" && !substituteFor && material && target?.kind === "order" && quantity !== null && (
            <div role="alert" className="flex flex-col gap-2 rounded-xl bg-amber-100 p-3 text-base text-amber-950">
              <span>Nie udało się sprawdzić odpowiedników ({subChoice.message}).</span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void loadSubChoice(target.id, material.id, quantity)}>
                  Ponów
                </Button>
                <Button type="button" variant="outline" onClick={() => setSubChoice(null)}>
                  Wydaj jako zwykłe wydanie
                </Button>
              </div>
            </div>
          )}
          {subChoice?.status === "ok" && !substituteFor && (
            <fieldset className="flex flex-col gap-2 rounded-2xl border-2 border-amber-400 p-4" disabled={frozen || op.submitting}>
              <legend className="px-1 text-lg font-bold">
                {material.code} nie ma „pozostało” na tym zleceniu — jest odpowiednikiem pozycji zlecenia
              </legend>
              {subChoice.candidates.map((c) => {
                const qtyErr = quantity === null ? null : substituteQuantityError(quantity, c);
                return (
                  <label key={c.id} className="flex min-h-14 items-center gap-3 rounded-xl border bg-background px-4 py-2 text-lg">
                    <input
                      type="radio"
                      name="sub-choice"
                      className="size-6"
                      checked={subChoice.selected === c.id}
                      disabled={qtyErr !== null}
                      onChange={() => setSubChoice({ ...subChoice, selected: c.id })}
                    />
                    <span>
                      Policz jako zamiennik za <span className="font-mono font-bold">{c.code}</span>
                      <span className="block text-sm text-muted-foreground">
                        {c.name} · pozostało {formatQuantityUnit(c.remaining, c.unit)}
                      </span>
                      {qtyErr && <span className="block text-sm font-semibold text-destructive">{qtyErr}</span>}
                    </span>
                  </label>
                );
              })}
              <label className="flex min-h-14 items-center gap-3 rounded-xl border bg-background px-4 py-2 text-lg">
                <input
                  type="radio"
                  name="sub-choice"
                  className="size-6"
                  checked={subChoice.selected === ""}
                  onChange={() => setSubChoice({ ...subChoice, selected: "" })}
                />
                <span>Zwykłe wydanie (nadwydanie — nie zmniejszy „pozostało” innej pozycji)</span>
              </label>
            </fieldset>
          )}

          {overrideMode && (
            <section className="flex flex-col gap-2 rounded-2xl bg-amber-100 p-4 text-amber-950">
              <p className="text-lg font-bold">Wydanie mimo rezerwacji (ADMIN)</p>
              <p className="text-base">
                Część towaru jest zarezerwowana dla innych zleceń. Zatwierdzenie zmniejszy ich rezerwacje (od najnowszej) i
                zostanie zapisane w historii z powodem.
              </p>
              <label htmlFor="override-reason" className="text-base font-semibold">
                Powód (wymagany)
              </label>
              <textarea
                id="override-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                maxLength={MAX_REASON_LENGTH}
                rows={2}
                disabled={frozen || op.submitting}
                className="w-full rounded-xl border border-input bg-background px-4 py-3 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </section>
          )}

          {op.error && <SubmitErrorAlert error={op.error} menuLabel="WYDANIE" />}
          {op.error?.code === "RESERVED_STOCK" && isAdmin && !overrideMode && (
            <Button type="button" variant="outline" className={`${BIG_SECONDARY} border-amber-500 text-amber-900`} onClick={startOverride}>
              Wydaj mimo rezerwacji…
            </Button>
          )}

          <Button
            type="button"
            className={BIG_PRIMARY}
            disabled={
              op.submitting ||
              op.error?.kind === "domain" ||
              (subPending && !op.unresolved) ||
              (overrideMode && !op.unresolved && overrideReason.trim().length < MIN_OVERRIDE_REASON_LENGTH)
            }
            onClick={(e) => guard.allow(e) && (op.unresolved && op.pending ? void send(op.pending) : confirm())}
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
            {result.substituteFor && (
              <p className="mt-2 text-lg font-bold">
                Zamiennik za {result.substituteFor.code}
              </p>
            )}
            {(result.substituteReservationReleased ?? 0) > 0 && result.substituteFor && (
              <p className="mt-1 text-base">
                Rezerwacja {result.substituteFor.code} na tym zleceniu zmniejszona o {formatQuantity(result.substituteReservationReleased ?? 0)}
              </p>
            )}
            {(result.reservationConsumed ?? 0) > 0 && (
              <p className="mt-2 text-base">
                Z rezerwacji zlecenia: {formatQuantityUnit(result.reservationConsumed ?? 0, material.unit)}
              </p>
            )}
            {(result.reservationsOverridden ?? []).length > 0 && (
              <p className="mt-2 text-base font-semibold">
                Zmniejszono rezerwacje innych zleceń o{" "}
                {formatQuantityUnit((result.reservationsOverridden ?? []).reduce((sum, o) => sum + o.quantity, 0), material.unit)}
              </p>
            )}
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

/** Lista zleceń do wydania (Otwarte i W produkcji): ostatnio używane na górze, wyszukiwanie po nazwie lub numerze
 * (nazwy mogą się powtarzać — numer, data i notatka). */
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
        const params = new URLSearchParams({ status: "ISSUABLE", q: term, pageSize: "30" });
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
        <span className="text-xl font-bold break-words">
          {o.name}
          {o.status === "IN_PRODUCTION" && (
            <span className="ml-2 rounded-md bg-sky-100 px-2 py-0.5 align-middle text-sm font-semibold text-sky-900">
              {ORDER_STATUS_LABELS.IN_PRODUCTION}
            </span>
          )}
        </span>
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
        placeholder="Szukaj zlecenia (nazwisko, numer)"
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
              <p className="text-base font-semibold text-muted-foreground">Zlecenia do wydania (najnowsze)</p>
              <ul className="flex flex-col gap-2">{rest.map(row)}</ul>
            </>
          )}
          {recent.length === 0 && initial.length === 0 && (
            <p className="rounded-xl border bg-background p-4 text-center text-muted-foreground">Brak zleceń do wydania.</p>
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
        <p className="rounded-xl border bg-background p-4 text-center text-muted-foreground">Brak zleceń do wydania dla tej frazy.</p>
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

/**
 * Pobiera „Do wydania na to zlecenie”; odświeża przy każdym wejściu w krok wyboru materiału (po wydaniu lista się
 * zmienia). Stan „wczytywanie” wynika z tego, że wynik dotyczy innego zlecenia (bez setState w efekcie).
 */
function useToIssue(orderId: string | null, active: boolean) {
  const [state, setState] = useState<{ kind: "ok" | "error"; items: ToIssueDto[]; orderId: string; message?: string } | null>(null);
  // Każde wejście w krok wyboru materiału unieważnia stary wynik (stan „wczytywanie” do nowej odpowiedzi) —
  // po wydaniu lista i podpowiedź ilości nie mogą pochodzić sprzed wydania.
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (active) setState(null);
  }
  useEffect(() => {
    if (!orderId || !active) return;
    const controller = new AbortController();
    fetch(`/api/v1/orders/${orderId}/to-issue`, { signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as { data?: ToIssueDto[]; error?: { message?: string } } | null;
        if (!res.ok || !json?.data) {
          setState({ kind: "error", items: [], orderId, message: json?.error?.message ?? `Błąd (${res.status})` });
          return;
        }
        setState({ kind: "ok", items: json.data, orderId });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setState({ kind: "error", items: [], orderId, message: "Brak połączenia z serwerem" });
      });
    return () => controller.abort();
  }, [orderId, active]);
  if (!orderId) return { kind: "none" as const, items: [] as ToIssueDto[], message: undefined as string | undefined };
  if (!state || state.orderId !== orderId) return { kind: "loading" as const, items: [] as ToIssueDto[], message: undefined as string | undefined };
  return state;
}

type ToIssueState = ReturnType<typeof useToIssue>;

/** „Do wydania na to zlecenie”: pozycje zapotrzebowania z pozostało > 0; tapnięcie wybiera materiał. */
function ToIssueList({
  state,
  message,
  onSelect,
  onSubstitute,
}: {
  state: ToIssueState;
  message: string | null;
  onSelect: (i: ToIssueDto) => void;
  onSubstitute: (i: ToIssueDto, sub: SubstituteOption) => void;
}) {
  if (state.kind === "loading") {
    return <p className="text-muted-foreground">Wczytywanie zapotrzebowania…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="rounded-xl bg-muted p-3 text-base text-muted-foreground">
        Nie udało się wczytać zapotrzebowania ({state.message}). Wyszukaj materiał poniżej.
      </p>
    );
  }
  if (state.items.length === 0) return null;
  return (
    <section aria-label="Do wydania na to zlecenie" className="flex flex-col gap-2">
      <h3 className="text-lg font-bold">Do wydania na to zlecenie</h3>
      <ul className="flex flex-col gap-2">
        {state.items.map((i) => (
          <li key={i.materialId}>
            <button type="button" className={BIG_ROW} onClick={() => onSelect(i)}>
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="font-mono text-xl font-bold break-all">{i.materialCode}</span>
                <span className="shrink-0 text-lg font-bold">{formatQuantityUnit(i.remaining, i.unit)}</span>
              </span>
              <span className="text-base text-muted-foreground">{i.materialName}</span>
              {i.reserved > 0 && (
                <span className="text-sm text-emerald-800">zarezerwowane dla zlecenia: {formatQuantityUnit(i.reserved, i.unit)}</span>
              )}
              {i.available <= 0 && <span className="text-sm font-semibold text-destructive">brak wolnego towaru</span>}
            </button>
            {/* Etap 12b: za mało oryginału — odpowiedniki z dostępnym towarem (tapnięcie = wydanie zamiennika). */}
            {i.available < i.remaining &&
              (i.substitutes ?? [])
                .filter((sub) => sub.available > 0)
                .map((sub) => (
                  <button
                    key={sub.materialId}
                    type="button"
                    className="mt-1 ml-4 flex min-h-14 w-[calc(100%-1rem)] flex-col items-start rounded-xl border border-amber-400 bg-amber-50 px-4 py-2 text-left text-amber-950 active:bg-amber-100"
                    onClick={() => onSubstitute(i, sub)}
                  >
                    <span className="text-base font-bold">
                      Odpowiednik <span className="font-mono">{sub.code}</span>: dostępne {formatQuantityUnit(sub.available, sub.unit)}
                    </span>
                    <span className="text-sm">
                      {sub.name} — wydaj jako zamiennik za {i.materialCode}
                    </span>
                  </button>
                ))}
          </li>
        ))}
      </ul>
      {message && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-base font-medium text-destructive">
          {message}
        </p>
      )}
      <p className="text-sm text-muted-foreground">Pozostałe materiały wyszukasz poniżej.</p>
    </section>
  );
}

/** Etap 11: „do wydania: X (w tym rezerwacja tego zlecenia: Y)” / „wolne: X (zarezerwowane dla innych: Y)”. */
function ReservationInfo({
  avail,
  failed,
  onRetry,
  unit,
  forOrder,
}: {
  avail: MaterialAvailabilityDto | null;
  failed: boolean;
  onRetry: () => void;
  unit: string;
  forOrder: boolean;
}) {
  if (failed) {
    // L3: bez danych o rezerwacjach decyduje serwer (RESERVED_STOCK) — informujemy i pozwalamy ponowić.
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-100 p-3 text-base text-amber-950">
        <span>Nie udało się sprawdzić rezerwacji.</span>
        <Button type="button" variant="outline" onClick={onRetry}>
          Ponów
        </Button>
      </div>
    );
  }
  if (!avail) return <p className="text-base text-muted-foreground">Sprawdzanie rezerwacji…</p>;
  const others = Math.max(0, avail.reservedTotal - avail.ownReserved);
  return (
    <p className="rounded-xl bg-muted p-3 text-base">
      {forOrder ? (
        <>
          Dostępne dla tego zlecenia: <strong>{formatQuantityUnit(avail.availableForIssue, unit)}</strong>
          {avail.ownReserved > 0 && <> (w tym rezerwacja tego zlecenia: {formatQuantityUnit(avail.ownReserved, unit)})</>}
        </>
      ) : (
        <>
          Wolne: <strong>{formatQuantityUnit(avail.free, unit)}</strong>
        </>
      )}
      {others > 0 && <> · zarezerwowane dla innych zleceń: {formatQuantityUnit(others, unit)}</>}
    </p>
  );
}
