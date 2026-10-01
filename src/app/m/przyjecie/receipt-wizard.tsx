"use client";

import { useState, type FormEvent } from "react";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PendingOperation } from "@/lib/pending-operation";
import { fetchLocationByCode, type ReceiptResponse } from "@/lib/stock-client";
import {
  MAX_DOCUMENT_REF_LENGTH,
  MAX_NOTE_LENGTH,
  checkQuantity,
  formatQuantity,
  formatQuantityUnit,
} from "@/lib/validation/stock";
import { CodeScanner } from "../code-scanner";
import { useOperationSubmit } from "../use-operation-submit";
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

export type WizardLocation = { id: string; code: string; name: string | null };
type Supplier = { id: string; name: string };
type Step = "location" | "material" | "quantity" | "summary" | "done";
type PendingReceipt = PendingOperation<"RECEIPT">;

const SELECT_LG =
  "h-14 w-full rounded-xl border border-input bg-background px-3 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const STEP_NO: Record<Step, number> = { location: 1, material: 2, quantity: 3, summary: 4, done: 4 };

export function ReceiptWizard({
  userId,
  initialLocation,
  initialMessage,
  suppliers,
  recent: initialRecent,
}: {
  userId: string;
  initialLocation: WizardLocation | null;
  initialMessage: string | null;
  suppliers: Supplier[];
  recent: PickedMaterial[];
}) {
  const [step, setStep] = useState<Step>(initialLocation ? "material" : "location");
  const [location, setLocation] = useState<WizardLocation | null>(initialLocation);
  const [scanMessage, setScanMessage] = useState<string | null>(initialMessage);
  const [scanKey, setScanKey] = useState(0);
  const [lookingUp, setLookingUp] = useState(false);

  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [recent, setRecent] = useState(initialRecent);
  const [qtyText, setQtyText] = useState("");
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null); // zatwierdzona w kroku ilości
  const [supplierId, setSupplierId] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [note, setNote] = useState("");

  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<ReceiptResponse | null>(null);
  // Wspólny mechanizm wysyłki (sessionStorage, ponowienie tym samym id, beforeunload) — ADR 010.
  const op = useOperationSubmit("RECEIPT", userId);

  async function onScanned(code: string) {
    setLookingUp(true);
    setScanMessage(null);
    const found = await fetchLocationByCode(code);
    setLookingUp(false);
    if (found.kind === "error") {
      setScanMessage(found.message);
      setScanKey((k) => k + 1); // ponowne uruchomienie skanera
      return;
    }
    if (!found.data.active) {
      setScanMessage(`Lokalizacja ${found.data.code} jest nieaktywna. Wybierz inną.`);
      setScanKey((k) => k + 1);
      return;
    }
    setLocation({ id: found.data.id, code: found.data.code, name: found.data.name });
    setStep("material");
  }

  function pickMaterial(m: PickedMaterial) {
    setMaterial(m);
    setQtyText("");
    setQtyError(null);
    setSupplierId(m.defaultSupplierId && suppliers.some((s) => s.id === m.defaultSupplierId) ? m.defaultSupplierId : "");
    setDocumentRef("");
    setNote("");
    setStep("quantity");
  }

  function goSummary(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!material) return;
    const check = checkQuantity(qtyText, material.allowsFraction);
    if (!check.ok) {
      setQtyError(check.message);
      return;
    }
    if (documentRef.trim().length > MAX_DOCUMENT_REF_LENGTH || note.trim().length > MAX_NOTE_LENGTH) {
      setQtyError("Za długi numer dokumentu lub notatka");
      return;
    }
    setQuantity(check.value);
    // Nowy identyfikator żądania dla każdego nowego podsumowania (zmienione dane = nowa operacja).
    setRequestId(crypto.randomUUID());
    op.clearError();
    setStep("summary");
  }

  async function send(p: PendingReceipt) {
    const data = await op.send(p);
    if (!data) return;
    setResult(data);
    setRecent((list) => [p.ctx.material, ...list.filter((m) => m.id !== p.ctx.material.id)].slice(0, 5));
    setStep("done");
  }

  function confirm() {
    if (!location || !material || !requestId || quantity === null) return;
    void send({
      v: 2,
      kind: "RECEIPT",
      userId,
      requestId,
      payload: {
        client_request_id: requestId,
        location_id: location.id,
        material_id: material.id,
        quantity,
        supplier_id: supplierId || null,
        document_ref: documentRef.trim() || null,
        note: note.trim() || null,
      },
      ctx: { location, material, supplierName: suppliers.find((s) => s.id === supplierId)?.name ?? null },
      savedAt: Date.now(),
    });
  }

  /** Dokończenie zapisanego żądania: odtworzenie ekranu podsumowania i ponowienie tym samym id. */
  function resume(p: PendingReceipt) {
    setLocation(p.ctx.location);
    setMaterial(p.ctx.material);
    setQuantity(p.payload.quantity);
    setQtyText(formatQuantity(p.payload.quantity));
    setSupplierId(p.payload.supplier_id ?? "");
    setDocumentRef(p.payload.document_ref ?? "");
    setNote(p.payload.note ?? "");
    setRequestId(p.requestId);
    setResult(null);
    setStep("summary");
    void send(p);
  }

  function discardPending() {
    if (!op.discard("Porzucić niepotwierdzone przyjęcie? Sprawdź w „Moich ostatnich operacjach”, czy zostało zapisane.")) {
      return;
    }
    setRequestId(null);
    setMaterial(null);
    setResult(null);
    setStep(location ? "material" : "location");
  }

  function nextMaterial() {
    setMaterial(null);
    setResult(null);
    setRequestId(null);
    op.clearError();
    setStep("material");
  }

  function changeLocation() {
    setLocation(null);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("location");
  }

  if (op.showResume && op.pending) {
    const p = op.pending;
    return (
      <ResumeScreen title="Przyjęcie" what="przyjęcie" onResume={() => resume(p)} onDiscard={discardPending}>
        <p className="font-mono text-4xl font-extrabold break-all">{formatQuantityUnit(p.payload.quantity, p.ctx.material.unit)}</p>
        <p className="mt-1 text-xl font-semibold break-all">{p.ctx.material.code}</p>
        <p className="text-base text-muted-foreground">{p.ctx.material.name}</p>
        <p className="mt-2 text-lg">
          do <span className="font-mono text-2xl font-bold">{p.ctx.location.code}</span>
        </p>
        {p.ctx.supplierName && <p className="mt-2 text-base">Dostawca: {p.ctx.supplierName}</p>}
        {p.payload.document_ref && <p className="text-base break-all">Dokument: {p.payload.document_ref}</p>}
      </ResumeScreen>
    );
  }

  const frozen = step === "summary" && op.locked;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <WizardHeader title="Przyjęcie" step={STEP_NO[step]} total={4} locked={op.locked} />

      {location && step !== "location" && step !== "done" && (
        <ContextRow label="Lokalizacja" value={location.code} sub={location.name} onChange={frozen ? undefined : changeLocation} />
      )}
      {material && (step === "quantity" || step === "summary") && (
        <ContextRow
          label="Materiał"
          value={material.code}
          sub={`${material.name} · ${material.unit}`}
          onChange={frozen ? undefined : () => setStep("material")}
        />
      )}

      {step === "location" && (
        <>
          <h2 className="text-2xl font-bold">Zeskanuj lokalizację</h2>
          {lookingUp && <p className="rounded-xl bg-muted p-4 text-lg">Sprawdzanie kodu…</p>}
          <CodeScanner key={scanKey} onCode={onScanned} message={scanMessage} submitLabel="Dalej" />
        </>
      )}

      {step === "material" && (
        <>
          <h2 className="text-2xl font-bold">Wybierz materiał</h2>
          <MaterialPicker onSelect={pickMaterial} recent={recent} recentLabel="Ostatnio przyjmowane" />
        </>
      )}

      {step === "quantity" && material && (
        <form onSubmit={goSummary} noValidate className="flex flex-col gap-4">
          <label htmlFor="qty" className="text-2xl font-bold">
            Ilość
          </label>
          <QuantityInput
            value={qtyText}
            onChange={(v) => (setQtyText(v), setQtyError(null))}
            unit={material.unit}
            allowsFraction={material.allowsFraction}
            error={qtyError}
          />

          <details className="rounded-2xl border bg-background p-4">
            <summary className="flex min-h-12 cursor-pointer items-center text-lg font-semibold">
              Więcej (dostawca, dokument, notatka)
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="supplier" className="text-base font-medium">
                  Dostawca
                </label>
                <select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={SELECT_LG}>
                  <option value="">— brak / nieznany —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.id === material.defaultSupplierId ? " (domyślny)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="docref" className="text-base font-medium">
                  Nr dokumentu (WZ / faktura)
                </label>
                <Input
                  id="docref"
                  value={documentRef}
                  onChange={(e) => setDocumentRef(e.target.value)}
                  maxLength={MAX_DOCUMENT_REF_LENGTH}
                  autoComplete="off"
                  className="h-14 rounded-xl px-4 text-lg"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="note" className="text-base font-medium">
                  Notatka
                </label>
                <textarea
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={MAX_NOTE_LENGTH}
                  rows={2}
                  className="w-full rounded-xl border border-input bg-transparent px-4 py-3 text-lg outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>
            </div>
          </details>

          <Button type="submit" className={BIG_PRIMARY}>
            Dalej
          </Button>
        </form>
      )}

      {step === "summary" && location && material && (
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border bg-background p-5 text-center">
            <p className="text-lg text-muted-foreground">Przyjmujesz</p>
            <p className="my-1 font-mono text-5xl font-extrabold break-all">
              {formatQuantity(quantity ?? 0)}
              <span className="ml-2 text-3xl font-bold">{material.unit}</span>
            </p>
            <p className="text-xl font-semibold break-all">{material.code}</p>
            <p className="text-base text-muted-foreground">{material.name}</p>
            <p className="mt-3 text-lg">
              do <span className="font-mono text-2xl font-bold">{location.code}</span>
            </p>
            {(supplierId || documentRef.trim() || note.trim()) && (
              <dl className="mt-3 space-y-1 text-left text-base">
                {supplierId && (
                  <div>
                    <dt className="inline text-muted-foreground">Dostawca: </dt>
                    <dd className="inline">{suppliers.find((s) => s.id === supplierId)?.name}</dd>
                  </div>
                )}
                {documentRef.trim() && (
                  <div>
                    <dt className="inline text-muted-foreground">Dokument: </dt>
                    <dd className="inline break-all">{documentRef.trim()}</dd>
                  </div>
                )}
                {note.trim() && (
                  <div>
                    <dt className="inline text-muted-foreground">Notatka: </dt>
                    <dd className="inline break-words">{note.trim()}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          {op.error && <SubmitErrorAlert error={op.error} menuLabel="PRZYJĘCIE" />}

          <Button
            type="button"
            className={BIG_PRIMARY}
            disabled={op.submitting}
            // Ponowienie: dokładnie zapisane żądanie (ten sam id i payload); pierwsze wysłanie: z bieżących danych.
            onClick={() => (op.unresolved && op.pending ? void send(op.pending) : confirm())}
          >
            {op.submitting ? "Zapisywanie…" : op.unresolved ? "Spróbuj ponownie" : "ZATWIERDŹ"}
          </Button>
          {op.unresolved ? (
            <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={op.submitting} onClick={discardPending}>
              Porzuć — sprawdzę w ostatnich operacjach
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={BIG_SECONDARY}
              disabled={op.submitting}
              onClick={() => setStep("quantity")}
            >
              Popraw ilość
            </Button>
          )}
        </div>
      )}

      {step === "done" && result && location && material && (
        <div className="flex flex-col gap-4">
          <section role="status" className="rounded-2xl bg-emerald-100 p-5 text-center text-emerald-950">
            <p className="text-2xl font-bold">Przyjęto {formatQuantityUnit(result.quantity, material.unit)}</p>
            <p className="mt-1 text-lg break-all">
              {material.code} — {material.name}
            </p>
            <p className="mt-1 text-lg">
              do <span className="font-mono font-bold">{location.code}</span>
            </p>
            <p className="mt-3 text-xl">
              Stan w lokalizacji: <span className="font-bold">{formatQuantityUnit(result.newLocationQuantity, material.unit)}</span>
            </p>
            {result.idempotentReplay && (
              <p className="mt-2 text-base">Ta operacja była już zapisana — nie została zdublowana.</p>
            )}
          </section>
          <Button type="button" className={BIG_PRIMARY} onClick={nextMaterial}>
            Kolejny materiał w tej lokalizacji
          </Button>
          <FinishLink />
        </div>
      )}
    </div>
  );
}
