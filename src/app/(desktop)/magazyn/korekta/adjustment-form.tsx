"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Field, NoticeBox, SELECT_CLASS, UnresolvedAttemptAlert } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDelta, previewAdjustment, quantityDelta, reservationShortfallAfterAdjust } from "@/lib/adjustment";
import type { Notice } from "@/lib/api-client";
import {
  fetchCurrentQuantity,
  fetchLocationByCode,
  submitAdjustment,
  type AdjustmentPayload,
  type CurrentQuantity,
} from "@/lib/stock-client";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { useMaterialAvailability } from "@/lib/availability-client";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import { parseScannedCode } from "@/lib/validation/locations";
import {
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_LABELS,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  endSentence,
  formatQuantityUnit,
  type AdjustmentReasonCode,
} from "@/lib/validation/stock";

export type AdjustLocation = { id: string; code: string; active: boolean };

type Current = { kind: "idle" } | CurrentQuantity;

/**
 * Formularz korekty ADMIN-a (desktop): materiał + lokalizacja → aktualny stan → faktyczna ilość (różnica na żywo)
 * → powód → potwierdzenie. Wysyła `expected_current` = stan pokazany ADMIN-owi; STOCK_CHANGED odświeża stan
 * i wymaga ponownego potwierdzenia. Ochrona przed duplikatem jak w innych formularzach (useOperationAttempt).
 */
export function AdjustmentForm({
  initialMaterial,
  initialLocation,
}: {
  initialMaterial: PickedMaterial | null;
  initialLocation: AdjustLocation | null;
}) {
  const router = useRouter();
  const [material, setMaterial] = useState<PickedMaterial | null>(initialMaterial);
  const [location, setLocation] = useState<AdjustLocation | null>(initialLocation);
  const [locationCode, setLocationCode] = useState("");
  const [current, setCurrent] = useState<Current>({ kind: "idle" });
  const [qty, setQty] = useState("");
  const [reasonCode, setReasonCode] = useState<AdjustmentReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [reload, setReload] = useState(0);
  const att = useOperationAttempt<AdjustmentPayload>();
  const guard = useConfirmGuard();
  const locked = att.locked || lookingUp;

  const materialId = material?.id;
  const locationId = location?.id;
  useEffect(() => {
    if (!materialId || !locationId) return;
    let cancelled = false;
    void fetchCurrentQuantity(materialId, locationId).then((c) => !cancelled && setCurrent(c));
    return () => {
      cancelled = true;
    };
  }, [materialId, locationId, reload]);

  const unit = material?.unit ?? "";
  const currentValue = current.kind === "ok" ? current.value : null;
  const preview = currentValue === null ? null : previewAdjustment(qty, currentValue, unit, material?.allowsFraction ?? true);
  const inactive = material?.active === false || location?.active === false;
  const avail = useMaterialAvailability(material?.id, reload);

  function clearFeedback() {
    setNotice(null);
    setConfirming(false);
  }

  async function pickLocation() {
    const code = parseScannedCode(locationCode);
    if (!code) return setErrors({ location: "Podaj poprawny kod lokalizacji" });
    setLookingUp(true);
    const loc = await fetchLocationByCode(code).finally(() => setLookingUp(false));
    if (loc.kind === "error") return setErrors({ location: loc.message });
    setErrors({});
    setCurrent({ kind: "loading" });
    setLocation({ id: loc.data.id, code: loc.data.code, active: loc.data.active });
  }

  function validate(): AdjustmentPayload | null {
    const errs: Record<string, string> = {};
    if (!material) errs.material = "Wybierz materiał";
    if (!location) errs.location = "Wybierz lokalizację";
    if (!reasonCode) errs.reason_code = "Wybierz powód korekty";
    if (reasonCode === "INNY" && !reasonText.trim()) errs.reason = "Opisz powód korekty";
    if (!preview || preview.kind === "empty") errs.quantity = "Podaj faktyczną ilość";
    else if (preview.kind === "invalid") errs.quantity = preview.message;
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !material || !location || !preview || currentValue === null) return null;
    if (preview.kind === "same") {
      setNotice({ kind: "ok", text: "Stan się zgadza — brak korekty." });
      return null;
    }
    if (preview.kind !== "diff") return null;
    if (preview.delta > 0 && inactive) {
      setErrors({ quantity: "Nieaktywny materiał lub lokalizacja — można tylko zmniejszyć stan" });
      return null;
    }
    return {
      client_request_id: "",
      material_id: material.id,
      location_id: location.id,
      target_quantity: preview.target,
      expected_current: currentValue,
      reason_code: reasonCode,
      reason: reasonText.trim() || null,
      note: note.trim() || null,
    };
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (validate()) {
      guard.arm();
      setConfirming(true);
    }
  }

  async function confirm() {
    const current = att.current();
    if (current.status === "sending") return;
    const retrying = current.status === "unknown" || current.status === "auth";
    const payload = retrying ? null : validate();
    if (!retrying && !payload) return setConfirming(false);
    const res = await att.run(payload, submitAdjustment);
    if (!res) return;
    if (res.kind === "ok") {
      const d = res.data;
      setNotice({
        kind: "ok",
        text: endSentence(
          `Zapisano korektę ${material?.code ?? ""} w ${location?.code ?? ""}: ${formatQuantityUnit(d.previousQuantity, unit)} → ` +
            `${formatQuantityUnit(d.newQuantity, unit)} (${formatDelta(d.quantityDelta, unit)})` +
            (d.idempotentReplay ? " (operacja była już zapisana — bez duplikatu)" : ""),
        ),
      });
      setCurrent({ kind: "ok", value: d.newQuantity });
      setQty("");
      setNote("");
      setConfirming(false);
      router.refresh();
    } else if (res.kind === "error") {
      setConfirming(false);
      if (res.code === "STOCK_CHANGED" && typeof res.details?.current === "number") {
        // Stan zmienił się od chwili, gdy ADMIN go widział — pokazujemy nowy i wymagamy ponownego potwierdzenia.
        setCurrent({ kind: "ok", value: res.details.current });
        setNotice({
          kind: "error",
          text: `${endSentence(`Stan zmienił się w międzyczasie — teraz: ${formatQuantityUnit(res.details.current, unit)}`)} Sprawdź różnicę i zatwierdź ponownie.`,
        });
      } else {
        setNotice({ kind: "error", text: res.message });
        if (res.code === "NO_CHANGE") setReload((n) => n + 1);
      }
    }
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzoną korektę? Sprawdź w historii ruchów, czy została zapisana.")) return;
    att.discard();
    setConfirming(false);
    setNotice({ kind: "ok", text: "Porzucono. Sprawdź w historii ruchów, czy korekta została zapisana." });
    setReload((n) => n + 1);
  }

  const reasonLabel = reasonCode ? ADJUSTMENT_REASON_LABELS[reasonCode] : "";
  // Panel potwierdzenia: przy wyniku nieznanym pokazujemy DOKŁADNIE zapamiętane żądanie (to zostanie ponowione).
  const sent = att.unresolved ? att.attempt.payload : null;
  const shown = sent
    ? { from: sent.expected_current, to: sent.target_quantity }
    : confirming && preview?.kind === "diff" && currentValue !== null
      ? { from: currentValue, to: preview.target }
      : null;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <NoticeBox notice={notice} />
        {att.unresolved && (
          <UnresolvedAttemptAlert status={att.attempt.status} what="korekta" saved="została zapisana" listName="historii ruchów" />
        )}

        <form onSubmit={review} noValidate className="space-y-5">
          <fieldset disabled={locked || confirming} className="space-y-5">
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Materiał *</span>
              {material ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div>
                    <span className="font-mono font-semibold">{material.code}</span> · {material.name}{" "}
                    <span className="text-muted-foreground">({material.unit})</span>
                    {material.active === false && <span className="ml-1 text-xs text-destructive">nieaktywny</span>}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => (clearFeedback(), setMaterial(null), setCurrent({ kind: "idle" }))}>
                    Zmień
                  </Button>
                </div>
              ) : (
                <MaterialPicker size="md" includeInactive onSelect={(m) => (clearFeedback(), setCurrent({ kind: "loading" }), setMaterial(m))} />
              )}
              {errors.material && <p className="text-xs text-destructive">{errors.material}</p>}
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">Lokalizacja *</span>
              {location ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div>
                    <span className="font-mono font-semibold">{location.code}</span>
                    {!location.active && <span className="ml-2 text-xs text-destructive">nieaktywna</span>}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => (clearFeedback(), setLocation(null), setCurrent({ kind: "idle" }))}>
                    Zmień
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    aria-label="Kod lokalizacji"
                    value={locationCode}
                    onChange={(e) => setLocationCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void pickLocation();
                      }
                    }}
                    placeholder="np. A-03-02"
                    autoComplete="off"
                    className="font-mono uppercase"
                    aria-invalid={!!errors.location}
                  />
                  <Button type="button" variant="outline" onClick={() => void pickLocation()}>
                    Wybierz
                  </Button>
                </div>
              )}
              {errors.location && <p className="text-xs text-destructive">{errors.location}</p>}
            </div>

            {material && location && (
              <div className="rounded-lg bg-muted p-4" aria-live="polite">
                <div className="text-sm text-muted-foreground">Aktualny stan w {location.code}</div>
                {current.kind === "ok" ? (
                  <div className="text-2xl font-semibold">{formatQuantityUnit(current.value, unit)}</div>
                ) : current.kind === "error" ? (
                  <div role="alert" className="text-destructive">
                    {current.message}{" "}
                    <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>
                      Spróbuj ponownie
                    </button>
                  </div>
                ) : (
                  <div className="text-muted-foreground">Wczytywanie…</div>
                )}
                {inactive && (
                  <p className="mt-1 text-xs text-amber-800">Nieaktywny materiał lub lokalizacja — dozwolone tylko zmniejszenie stanu.</p>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="adj-qty" label={`Faktyczna ilość *${unit ? ` (${unit})` : ""}`} error={errors.quantity}>
                <Input
                  id="adj-qty"
                  value={qty}
                  onChange={(e) => (clearFeedback(), setQty(e.target.value))}
                  inputMode={material?.allowsFraction === false ? "numeric" : "decimal"}
                  placeholder={material?.allowsFraction === false ? "liczba całkowita, np. 0" : "np. 2,5"}
                  autoComplete="off"
                  aria-invalid={!!errors.quantity}
                  aria-describedby="adj-diff"
                />
              </Field>
              <div id="adj-diff" className="flex flex-col justify-end pb-1 text-sm" aria-live="polite">
                {preview?.kind === "diff" && (
                  <span>
                    Różnica:{" "}
                    <span className={`text-lg font-semibold ${preview.delta < 0 ? "text-destructive" : "text-emerald-700"}`}>
                      {preview.label}
                    </span>
                  </span>
                )}
                {preview?.kind === "same" && <span className="text-muted-foreground">Stan się zgadza — brak korekty</span>}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="adj-reason-code" label="Powód *" error={errors.reason_code}>
                <select
                  id="adj-reason-code"
                  value={reasonCode}
                  onChange={(e) => (clearFeedback(), setReasonCode(e.target.value as AdjustmentReasonCode | ""))}
                  className={`${SELECT_CLASS} w-full`}
                >
                  <option value="">— wybierz powód —</option>
                  {ADJUSTMENT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {ADJUSTMENT_REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="adj-reason" label={`Opis powodu${reasonCode === "INNY" ? " *" : ""}`} error={errors.reason}>
                <Input
                  id="adj-reason"
                  value={reasonText}
                  maxLength={MAX_REASON_LENGTH}
                  onChange={(e) => (clearFeedback(), setReasonText(e.target.value))}
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field id="adj-note" label="Notatka">
              <Input id="adj-note" value={note} maxLength={MAX_NOTE_LENGTH} onChange={(e) => (clearFeedback(), setNote(e.target.value))} autoComplete="off" />
            </Field>
          </fieldset>

          {!confirming && !att.unresolved && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={locked || current.kind !== "ok"}>
                Dalej — sprawdź korektę
              </Button>
              <Link href="/magazyn" className="inline-flex h-8 items-center px-2 text-sm underline underline-offset-4">
                Anuluj
              </Link>
            </div>
          )}
        </form>

        {shown && (
          <div role="alertdialog" aria-label="Potwierdź korektę" className="space-y-3 rounded-lg border-2 border-amber-400 p-4">
            <p className="font-semibold">
              Zmienić stan {material?.code} w {location?.code} z {formatQuantityUnit(shown.from, unit)} na{" "}
              {formatQuantityUnit(shown.to, unit)} ({formatDelta(quantityDelta(shown.to, shown.from), unit)})?
            </p>
            <p className="text-sm text-muted-foreground">
              Powód: {reasonLabel}
              {reasonText.trim() && ` — ${reasonText.trim()}`}
            </p>
            {(() => {
              const over = reservationShortfallAfterAdjust(avail, quantityDelta(shown.to, shown.from), location?.active !== false);
              return over > 0 ? (
                <p role="alert" className="rounded-md bg-amber-50 p-2 text-sm text-amber-950">
                  Uwaga: po korekcie rezerwacje zleceń przekroczą stan materiału o {formatQuantityUnit(over, unit)} (zarezerwowano{" "}
                  {formatQuantityUnit(avail?.reservedTotal ?? 0, unit)}). Rezerwacje nie zmienią się same — BIURO zdecyduje, którą zwolnić.
                </p>
              ) : null;
            })()}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={(e) => guard.allow(e) && void confirm()} disabled={att.sending}>
                {att.sending ? "Zapisywanie…" : att.unresolved ? "Ponów (ten sam id)" : "Zatwierdź korektę"}
              </Button>
              {att.unresolved ? (
                <Button type="button" variant="outline" onClick={discard}>
                  Porzuć — sprawdzę w historii
                </Button>
              ) : (
                <Button type="button" variant="outline" disabled={att.sending} onClick={() => setConfirming(false)}>
                  Wróć
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
