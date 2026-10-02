"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDelta, previewAdjustment, quantityDelta } from "@/lib/adjustment";
import { fetchCurrentQuantity, submitAdjustment, type AdjustmentPayload, type CurrentQuantity } from "@/lib/stock-client";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  MAX_REASON_LENGTH,
  endSentence,
  formatQuantityUnit,
  type AdjustmentReasonCode,
} from "@/lib/validation/stock";
import { BackLink } from "../back-link";
import { BIG_PRIMARY, BIG_ROW, BIG_SECONDARY, ContextRow, QuantityInput } from "../wizard-parts";

type Material = { id: string; code: string; name: string; unit: string; allowsFraction: boolean; active: boolean };
type Location = { id: string; code: string; active: boolean };
type Step = "form" | "confirm" | "done";

/**
 * Korekta na terminalu (ADMIN): stan aktualny → faktyczna ilość (różnica na żywo) → powód → potwierdzenie.
 * Ten sam endpoint co desktop; `expected_current` = stan pokazany na ekranie (STOCK_CHANGED → nowy stan i ponowne
 * potwierdzenie). Wynik nieznany: dane zamrożone, „Ponów” wysyła to samo żądanie (ten sam id).
 */
export function MobileAdjustForm({ backHref, location, material }: { backHref: string; location: Location; material: Material }) {
  const [current, setCurrent] = useState<CurrentQuantity>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [qty, setQty] = useState("");
  const [reasonCode, setReasonCode] = useState<AdjustmentReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const att = useOperationAttempt<AdjustmentPayload>();
  const guard = useConfirmGuard();

  useEffect(() => {
    let cancelled = false;
    void fetchCurrentQuantity(material.id, location.id).then((c) => !cancelled && setCurrent(c));
    return () => {
      cancelled = true;
    };
  }, [material.id, location.id, reload]);

  const unit = material.unit;
  const currentValue = current.kind === "ok" ? current.value : null;
  const preview = currentValue === null ? null : previewAdjustment(qty, currentValue, unit, material.allowsFraction);
  const inactive = !material.active || !location.active;

  function next() {
    setError(null);
    if (!preview || preview.kind === "empty") return setError("Podaj faktyczną ilość");
    if (preview.kind === "invalid") return setError(preview.message);
    if (preview.kind === "same") return setError("Stan się zgadza — brak korekty");
    if (preview.kind === "diff" && preview.delta > 0 && inactive) {
      return setError("Nieaktywny materiał lub lokalizacja — można tylko zmniejszyć stan");
    }
    if (!reasonCode) return setError("Wybierz powód korekty");
    if (reasonCode === "INNY" && !reasonText.trim()) return setError("Opisz powód korekty");
    guard.arm();
    setStep("confirm");
  }

  async function submit() {
    if (att.current().status === "sending") return;
    let payload: AdjustmentPayload | null = null;
    if (!att.unresolved) {
      if (!preview || preview.kind !== "diff" || currentValue === null || !reasonCode) return setStep("form");
      payload = {
        client_request_id: "",
        material_id: material.id,
        location_id: location.id,
        target_quantity: preview.target,
        expected_current: currentValue,
        reason_code: reasonCode,
        reason: reasonText.trim() || null,
        note: null,
      };
    }
    setError(null);
    const res = await att.run(payload, submitAdjustment);
    if (!res) return;
    if (res.kind === "ok") {
      const d = res.data;
      setResult(
        `${formatQuantityUnit(d.previousQuantity, unit)} → ${formatQuantityUnit(d.newQuantity, unit)} (${formatDelta(d.quantityDelta, unit)})` +
          (d.idempotentReplay ? " — była już zapisana, bez duplikatu" : ""),
      );
      setCurrent({ kind: "ok", value: d.newQuantity });
      setStep("done");
    } else if (res.kind === "error") {
      setStep("form");
      if (res.code === "STOCK_CHANGED" && typeof res.details?.current === "number") {
        setCurrent({ kind: "ok", value: res.details.current });
        setError(`${endSentence(`Stan zmienił się w międzyczasie — teraz: ${formatQuantityUnit(res.details.current, unit)}`)} Sprawdź i zatwierdź ponownie.`);
      } else {
        setError(res.message);
      }
    } else {
      setError(res.message);
    }
  }

  function discard() {
    att.discard();
    setStep("form");
    setError("Porzucono. Sprawdź stan lokalizacji — korekta mogła zostać zapisana.");
    setReload((n) => n + 1);
  }

  const sent = att.unresolved ? att.attempt.payload : null;
  const shown = sent
    ? { from: sent.expected_current, to: sent.target_quantity }
    : preview?.kind === "diff" && currentValue !== null
      ? { from: currentValue, to: preview.target }
      : null;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        {att.locked ? (
          <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">Dokończ korektę</span>
        ) : (
          <BackLink href={backHref}>Lokalizacja</BackLink>
        )}
        <h1 className="pr-3 text-xl font-bold">KOREKTA</h1>
      </header>

      <ContextRow label="Lokalizacja" value={location.code} sub={location.active ? null : "nieaktywna"} />
      <ContextRow label="Materiał" value={material.code} sub={`${material.name}${material.active ? "" : " (nieaktywny)"}`} />

      <section className="rounded-2xl border bg-background p-4 text-center" aria-live="polite">
        <div className="text-base text-muted-foreground">Stan w systemie</div>
        {current.kind === "ok" ? (
          <div className="text-3xl font-extrabold">{formatQuantityUnit(current.value, unit)}</div>
        ) : current.kind === "error" ? (
          <div role="alert" className="text-destructive">
            {current.message}
            <Button type="button" variant="outline" className={`${BIG_SECONDARY} mt-2`} onClick={() => (setCurrent({ kind: "loading" }), setReload((n) => n + 1))}>
              Spróbuj ponownie
            </Button>
          </div>
        ) : (
          <div className="text-xl text-muted-foreground">Wczytywanie…</div>
        )}
      </section>

      {step === "done" ? (
        <>
          <div role="status" className="rounded-2xl bg-emerald-100 p-5 text-emerald-950">
            <p className="text-xl font-bold">Zapisano korektę</p>
            <p className="mt-1 text-lg">{result}</p>
          </div>
          <Link
            href={backHref}
            className="flex h-16 w-full items-center justify-center rounded-2xl bg-primary text-2xl font-bold text-primary-foreground active:opacity-80"
          >
            Wróć do lokalizacji
          </Link>
        </>
      ) : step === "confirm" || att.unresolved ? (
        <>
          {shown && (
            <section className="rounded-2xl border-2 border-amber-400 bg-background p-5 text-center">
              <p className="text-lg">Ustawić stan na</p>
              <p className="text-4xl font-extrabold">{formatQuantityUnit(shown.to, unit)}</p>
              <p className="mt-1 text-2xl font-bold">{formatDelta(quantityDelta(shown.to, shown.from), unit)}</p>
              <p className="mt-2 text-base text-muted-foreground">
                Powód: {reasonCode ? ADJUSTMENT_REASON_LABELS[reasonCode] : ""}
                {reasonText.trim() && ` — ${reasonText.trim()}`}
              </p>
            </section>
          )}
          {error && (
            <p role="alert" className="rounded-xl bg-amber-100 p-4 text-base font-medium text-amber-900">
              {error}
              {att.unresolved && <span className="block font-normal">Ponów — jeśli korekta już się zapisała, nie zostanie zdublowana.</span>}
            </p>
          )}
          <Button type="button" className={BIG_PRIMARY} onClick={(e) => guard.allow(e) && void submit()} disabled={att.sending}>
            {att.sending ? "Zapisywanie…" : att.unresolved ? "Spróbuj ponownie" : "ZATWIERDŹ"}
          </Button>
          {att.unresolved ? (
            <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={discard}>
              Porzuć
            </Button>
          ) : (
            <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={att.sending} onClick={() => setStep("form")}>
              Wróć
            </Button>
          )}
        </>
      ) : (
        <>
          <label htmlFor="qty" className="text-lg font-semibold">
            Faktyczna ilość
          </label>
          <QuantityInput value={qty} onChange={(v) => (setError(null), setQty(v))} unit={unit} allowsFraction={material.allowsFraction} error={null} />
          <p className="min-h-8 text-center text-2xl font-bold" aria-live="polite">
            {preview?.kind === "diff" && (
              <span className={preview.delta < 0 ? "text-destructive" : "text-emerald-700"}>{preview.label}</span>
            )}
            {preview?.kind === "same" && <span className="text-base font-medium text-muted-foreground">Stan się zgadza</span>}
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-lg font-semibold">Powód</legend>
            {ADJUSTMENT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reasonCode === r}
                onClick={() => (setError(null), setReasonCode(r))}
                className={`${BIG_ROW} text-lg font-semibold ${reasonCode === r ? "border-2 border-primary bg-muted" : ""}`}
              >
                {ADJUSTMENT_REASON_LABELS[r]}
              </button>
            ))}
          </fieldset>
          {reasonCode && (
            <div className="flex flex-col gap-2">
              <label htmlFor="adj-reason" className="text-base font-medium">
                Opis{reasonCode === "INNY" ? " (wymagany)" : " (opcjonalnie)"}
              </label>
              <Input
                id="adj-reason"
                value={reasonText}
                maxLength={MAX_REASON_LENGTH}
                onChange={(e) => (setError(null), setReasonText(e.target.value))}
                autoComplete="off"
                className="h-14 rounded-xl px-4 text-lg"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
              {error}
            </p>
          )}
          <Button type="button" className={BIG_PRIMARY} onClick={next} disabled={current.kind !== "ok"}>
            Dalej
          </Button>
        </>
      )}
    </div>
  );
}
