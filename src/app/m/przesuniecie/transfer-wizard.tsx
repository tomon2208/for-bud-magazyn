"use client";

import { useState, type FormEvent } from "react";
import type { PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import type { PendingLocation, PendingOperation } from "@/lib/pending-operation";
import { fetchLocationByCode, fetchStock, type StockRow, type TransferResponse } from "@/lib/stock-client";
import { checkQuantity, formatQuantity, formatQuantityUnit } from "@/lib/validation/stock";
import { CodeScanner } from "../code-scanner";
import { StockRows } from "../stock-rows";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { useOperationSubmit, type SubmitError } from "../use-operation-submit";
import {
  BIG_PRIMARY,
  BIG_SECONDARY,
  ContextRow,
  FinishLink,
  QuantityInput,
  ResumeScreen,
  SubmitErrorAlert,
  WizardHeader,
} from "../wizard-parts";

type Step = "from" | "material" | "quantity" | "to" | "summary" | "done";
type PendingTransfer = PendingOperation<"TRANSFER">;

const STEP_NO: Record<Step, number> = { from: 1, material: 2, quantity: 3, to: 4, summary: 5, done: 5 };

export function TransferWizard({
  userId,
  presetFrom,
  presetMessage,
}: {
  userId: string;
  presetFrom: PendingLocation | null;
  presetMessage: string | null;
}) {
  const [step, setStep] = useState<Step>(presetFrom ? "material" : "from");
  const [from, setFrom] = useState<PendingLocation | null>(presetFrom);
  const [to, setTo] = useState<PendingLocation | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(presetMessage);
  const [scanKey, setScanKey] = useState(0);
  const [lookingUp, setLookingUp] = useState(false);

  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [available, setAvailable] = useState(0);
  const [qtyText, setQtyText] = useState("");
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);

  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<TransferResponse | null>(null);
  const op = useOperationSubmit("TRANSFER", userId);
  const guard = useConfirmGuard();

  /** Skan „skąd”: każda istniejąca lokalizacja (także nieaktywna — można ją opróżnić). */
  async function onScannedFrom(code: string) {
    setLookingUp(true);
    setScanMessage(null);
    const found = await fetchLocationByCode(code);
    setLookingUp(false);
    if (found.kind === "error") {
      setScanMessage(found.message);
      setScanKey((k) => k + 1);
      return;
    }
    setFrom({ id: found.data.id, code: found.data.code, name: found.data.name });
    setStep("material");
  }

  /** Skan „dokąd”: aktywna i inna niż źródłowa. */
  async function onScannedTo(code: string) {
    setLookingUp(true);
    setScanMessage(null);
    const found = await fetchLocationByCode(code);
    setLookingUp(false);
    const retry = (msg: string) => (setScanMessage(msg), setScanKey((k) => k + 1));
    if (found.kind === "error") return retry(found.message);
    if (!found.data.active) return retry(`Lokalizacja ${found.data.code} jest nieaktywna. Wybierz inną.`);
    if (found.data.id === from?.id) return retry("To ta sama lokalizacja, z której przesuwasz. Zeskanuj docelową.");
    setTo({ id: found.data.id, code: found.data.code, name: found.data.name });
    setRequestId(crypto.randomUUID());
    op.clearError();
    guard.arm();
    setStep("summary");
  }

  function pickStockRow(row: StockRow) {
    setMaterial({
      id: row.materialId,
      code: row.materialCode,
      name: row.materialName,
      unit: row.unit,
      allowsFraction: row.allowsFraction,
      defaultSupplierId: null,
    });
    setAvailable(row.quantity);
    setQtyText("");
    setQtyError(null);
    setStep("quantity");
  }

  function goTo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!material) return;
    const check = checkQuantity(qtyText, material.allowsFraction);
    if (!check.ok) return setQtyError(check.message);
    if (check.value > available) {
      return setQtyError(`Za dużo — dostępne tylko ${formatQuantityUnit(available, material.unit)}`);
    }
    setQuantity(check.value);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("to");
  }

  /** INSUFFICIENT_STOCK: od razu aktualna dostępność w lokalizacji źródłowej i komunikat z jednostką. */
  function onDomainError(p: PendingTransfer) {
    return (e: SubmitError): SubmitError => {
      if (e.code !== "INSUFFICIENT_STOCK" || e.available === undefined) return e;
      setAvailable(e.available);
      return {
        ...e,
        message: `Niewystarczający stan w ${p.ctx.from.code}. Dostępne: ${formatQuantityUnit(e.available, p.ctx.material.unit)}`,
      };
    };
  }

  async function send(p: PendingTransfer) {
    const data = await op.send(p, onDomainError(p));
    if (!data) return;
    setResult(data);
    setStep("done");
  }

  function confirm() {
    if (!from || !to || !material || !requestId || quantity === null) return;
    void send({
      v: 2,
      kind: "TRANSFER",
      userId,
      requestId,
      payload: {
        client_request_id: requestId,
        material_id: material.id,
        from_location_id: from.id,
        to_location_id: to.id,
        quantity,
        note: null,
      },
      ctx: { from, to, material },
      savedAt: Date.now(),
    });
  }

  function resume(p: PendingTransfer) {
    setFrom(p.ctx.from);
    setTo(p.ctx.to);
    setMaterial(p.ctx.material);
    setQuantity(p.payload.quantity);
    setQtyText(formatQuantity(p.payload.quantity));
    setRequestId(p.requestId);
    setResult(null);
    guard.arm();
    setStep("summary");
    // Dostępność nie jest zapisana w storage — pobieramy aktualną (potrzebna, gdy trzeba poprawić ilość).
    void fetchStock({ materialId: p.ctx.material.id, locationId: p.ctx.from.id }).then((r) => {
      if (r.kind === "ok") setAvailable(r.items[0]?.quantity ?? 0);
    });
    void send(p);
  }

  function discardPending() {
    if (!op.discard("Porzucić niepotwierdzone przesunięcie? Sprawdź w „Moich ostatnich operacjach”, czy zostało zapisane.")) {
      return;
    }
    setRequestId(null);
    setMaterial(null);
    setTo(null);
    setResult(null);
    setStep(from ? "material" : "from");
  }

  /** Po błędzie domenowym wracamy do właściwego kroku (dokąd / materiał / ilość). */
  function fixAfterError() {
    const err = op.error;
    op.clearError();
    if (err?.code === "LOCATION_INACTIVE" || err?.code === "SAME_LOCATION") {
      changeTo();
      return;
    }
    if (err?.code === "NOT_FOUND" || err?.code === "IDEMPOTENCY_CONFLICT") {
      setMaterial(null);
      setTo(null);
      setStep(from ? "material" : "from");
      return;
    }
    if (err?.code === "INSUFFICIENT_STOCK" && err.available !== undefined) setAvailable(err.available);
    setStep("quantity");
  }

  function changeTo() {
    setTo(null);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("to");
  }

  const fixLabel =
    op.error?.code === "LOCATION_INACTIVE" || op.error?.code === "SAME_LOCATION"
      ? "Zmień lokalizację docelową"
      : op.error?.code === "NOT_FOUND" || op.error?.code === "IDEMPOTENCY_CONFLICT"
        ? "Wybierz ponownie materiał"
        : "Popraw ilość";

  function nextMaterial() {
    setMaterial(null);
    setTo(null);
    setResult(null);
    setRequestId(null);
    op.clearError();
    setStep("material");
  }

  function changeFrom() {
    setFrom(null);
    setMaterial(null);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("from");
  }

  if (op.showResume && op.pending) {
    const p = op.pending;
    return (
      <ResumeScreen title="Przesunięcie" what="przesunięcie" onResume={() => resume(p)} onDiscard={discardPending}>
        <p className="font-mono text-4xl font-extrabold break-all">{formatQuantityUnit(p.payload.quantity, p.ctx.material.unit)}</p>
        <p className="mt-1 text-xl font-semibold break-all">{p.ctx.material.code}</p>
        <p className="text-base text-muted-foreground">{p.ctx.material.name}</p>
        <p className="mt-2 text-lg">
          <span className="font-mono text-2xl font-bold">{p.ctx.from.code}</span> →{" "}
          <span className="font-mono text-2xl font-bold">{p.ctx.to.code}</span>
        </p>
      </ResumeScreen>
    );
  }

  const frozen = step === "summary" && op.locked;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <WizardHeader title="Przesunięcie" step={STEP_NO[step]} total={5} locked={op.locked} />

      {from && step !== "from" && step !== "done" && (
        <ContextRow label="Skąd" value={from.code} sub={from.name} onChange={frozen ? undefined : changeFrom} />
      )}
      {material && (step === "quantity" || step === "to" || step === "summary") && (
        <ContextRow
          label="Materiał"
          value={material.code}
          sub={`${material.name} · dostępne: ${formatQuantityUnit(available, material.unit)}`}
          onChange={frozen ? undefined : () => setStep("material")}
        />
      )}
      {to && step === "summary" && (
        <ContextRow label="Dokąd" value={to.code} sub={to.name} onChange={frozen ? undefined : changeTo} />
      )}
      {material && quantity !== null && step === "to" && (
        <ContextRow label="Ilość" value={formatQuantityUnit(quantity, material.unit)} onChange={() => setStep("quantity")} />
      )}

      {step === "from" && (
        <>
          <h2 className="text-2xl font-bold">Skąd przesuwasz? Zeskanuj lokalizację</h2>
          {lookingUp && <p className="rounded-xl bg-muted p-4 text-lg">Sprawdzanie kodu…</p>}
          <CodeScanner key={scanKey} onCode={onScannedFrom} message={scanMessage} submitLabel="Dalej" />
        </>
      )}

      {step === "material" && from && (
        <>
          <h2 className="text-2xl font-bold">Co przesuwasz?</h2>
          <StockRows
            key={`from-${from.id}`}
            filter={{ locationId: from.id }}
            emptyText="Lokalizacja jest pusta — nie ma czego przesunąć."
            show="material"
            onSelect={pickStockRow}
          />
        </>
      )}

      {step === "quantity" && material && (
        <form onSubmit={goTo} noValidate className="flex flex-col gap-4">
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
          <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => (setQtyText(String(available).replace(".", ",")), setQtyError(null))}>
            Całość ({formatQuantityUnit(available, material.unit)})
          </Button>
          <Button type="submit" className={BIG_PRIMARY}>
            Dalej
          </Button>
        </form>
      )}

      {step === "to" && (
        <>
          <h2 className="text-2xl font-bold">Dokąd? Zeskanuj lokalizację docelową</h2>
          {lookingUp && <p className="rounded-xl bg-muted p-4 text-lg">Sprawdzanie kodu…</p>}
          <CodeScanner key={scanKey} onCode={onScannedTo} message={scanMessage} submitLabel="Dalej" />
        </>
      )}

      {step === "summary" && from && to && material && (
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border bg-background p-5 text-center">
            <p className="text-lg text-muted-foreground">Przesuwasz</p>
            <p className="my-1 font-mono text-5xl font-extrabold break-all">
              {formatQuantity(quantity ?? 0)}
              <span className="ml-2 text-3xl font-bold">{material.unit}</span>
            </p>
            <p className="text-xl font-semibold break-all">{material.code}</p>
            <p className="text-base text-muted-foreground">{material.name}</p>
            <p className="mt-3 text-lg">
              z <span className="font-mono text-2xl font-bold">{from.code}</span>
            </p>
            <p className="text-lg">
              do <span className="font-mono text-2xl font-bold">{to.code}</span>
            </p>
          </section>

          {op.error && <SubmitErrorAlert error={op.error} menuLabel="PRZESUNIĘCIE" />}

          <Button
            type="button"
            className={BIG_PRIMARY}
            disabled={op.submitting || op.error?.kind === "domain"}
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

      {step === "done" && result && from && to && material && (
        <div className="flex flex-col gap-4">
          <section role="status" className="rounded-2xl bg-emerald-100 p-5 text-center text-emerald-950">
            <p className="text-2xl font-bold">Przesunięto {formatQuantityUnit(result.quantity, material.unit)}</p>
            <p className="mt-1 text-lg break-all">
              {material.code} — {material.name}
            </p>
            <p className="mt-1 text-lg">
              <span className="font-mono font-bold">{from.code}</span> → <span className="font-mono font-bold">{to.code}</span>
            </p>
            <p className="mt-3 text-lg">
              Stan w {from.code}: <span className="font-bold">{formatQuantityUnit(result.fromLocationQuantity, material.unit)}</span>
            </p>
            <p className="text-lg">
              Stan w {to.code}: <span className="font-bold">{formatQuantityUnit(result.toLocationQuantity, material.unit)}</span>
            </p>
            {result.idempotentReplay && (
              <p className="mt-2 text-base">Ta operacja była już zapisana — nie została zdublowana.</p>
            )}
          </section>
          <Button type="button" className={BIG_PRIMARY} onClick={nextMaterial}>
            Kolejny materiał z {from.code}
          </Button>
          <FinishLink />
        </div>
      )}
    </div>
  );
}
