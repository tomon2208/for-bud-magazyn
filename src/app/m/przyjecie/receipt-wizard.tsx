"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clearPending, savePending, usePendingReceipt, type PendingReceipt } from "@/lib/pending-receipt";
import { fetchLocationByCode, submitReceipt, type ReceiptResponse } from "@/lib/stock-client";
import {
  MAX_DOCUMENT_REF_LENGTH,
  MAX_NOTE_LENGTH,
  checkQuantity,
  formatQuantity,
  formatQuantityUnit,
} from "@/lib/validation/stock";
import { BackLink } from "../back-link";
import { CodeScanner } from "../code-scanner";

export type WizardLocation = { id: string; code: string; name: string | null };
type Supplier = { id: string; name: string };
type Step = "location" | "material" | "quantity" | "summary" | "done";

/**
 * network — wynik nieznany (sieć / 5xx / RETRY) → ponów TEN SAM id; auth — sesja wygasła, operacja niewykonana,
 * ale zachowana do dokończenia po zalogowaniu; domain — serwer odrzucił → popraw dane.
 */
type SubmitError = { kind: "network" | "auth" | "domain"; message: string };

const BIG_PRIMARY = "h-16 w-full rounded-2xl text-2xl font-bold";
const BIG_SECONDARY = "h-14 w-full rounded-2xl text-lg font-semibold";
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
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false); // blokada podwójnego tapnięcia (niezależna od cyklu renderowania)
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [result, setResult] = useState<ReceiptResponse | null>(null);

  // Niepotwierdzone przyjęcie z sessionStorage. Jeśli nie powstało w tym ekranie (odświeżenie, powrót,
  // ponowne logowanie) — pokazujemy ekran dokończenia zamiast nowego przyjęcia.
  const pending = usePendingReceipt(userId);
  const [ownRequestId, setOwnRequestId] = useState<string | null>(null);
  const showResume = pending !== null && pending.requestId !== ownRequestId;

  // Po błędzie sieci / wygaśnięciu sesji nie pozwalamy zmieniać danych bez ponowienia albo jawnego porzucenia.
  const pendingUnknown = submitError?.kind === "network" || submitError?.kind === "auth";

  useEffect(() => {
    if (!pendingUnknown && !submitting) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // starsze przeglądarki
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingUnknown, submitting]);

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
    setSubmitError(null);
    setStep("summary");
  }

  /** Wysyła (albo ponawia) DOKŁADNIE zapisane żądanie. Zapis w storage trwa do jednoznacznego wyniku. */
  async function send(p: PendingReceipt) {
    if (lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setOwnRequestId(p.requestId);
    savePending(p);
    try {
      const res = await submitReceipt(p.payload);
      if (res.kind === "ok") {
        clearPending();
        setResult(res.data);
        setRecent((list) => [p.material, ...list.filter((m) => m.id !== p.material.id)].slice(0, 5));
        setStep("done");
      } else if (res.kind === "network" || res.kind === "auth") {
        setSubmitError({ kind: res.kind, message: res.message });
      } else {
        clearPending(); // serwer jednoznacznie odrzucił — nic nie zapisano
        setSubmitError({ kind: "domain", message: res.message });
      }
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  function confirm() {
    if (!location || !material || !requestId || quantity === null) return;
    void send({
      v: 1,
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
      location,
      material,
      supplierName: suppliers.find((s) => s.id === supplierId)?.name ?? null,
      savedAt: Date.now(),
    });
  }

  /** Dokończenie zapisanego żądania: odtworzenie ekranu podsumowania i ponowienie tym samym id. */
  function resume(p: PendingReceipt) {
    setLocation(p.location);
    setMaterial(p.material);
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
    if (!window.confirm("Porzucić niepotwierdzone przyjęcie? Sprawdź w „Moich ostatnich przyjęciach”, czy zostało zapisane.")) {
      return;
    }
    clearPending();
    setSubmitError(null);
    setOwnRequestId(null);
    setRequestId(null);
    setMaterial(null);
    setResult(null);
    setStep(location ? "material" : "location");
  }

  function nextMaterial() {
    setMaterial(null);
    setResult(null);
    setRequestId(null);
    setSubmitError(null);
    setStep("material");
  }

  function changeLocation() {
    setLocation(null);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("location");
  }

  if (showResume && pending) {
    const p = pending;
    return (
      <div className="flex flex-1 flex-col gap-4 p-4">
        <header className="flex items-center justify-between">
          <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">Przyjęcie</span>
        </header>
        <div role="alert" className="rounded-2xl bg-amber-100 p-5 text-amber-950">
          <p className="text-xl font-bold">Poprzednie przyjęcie nie zostało potwierdzone</p>
          <p className="mt-1 text-base">
            Nie wiadomo, czy zapisało się w systemie. Ponów — jeśli już zostało zapisane, nie zostanie zdublowane.
          </p>
        </div>
        <section className="rounded-2xl border bg-background p-5 text-center">
          <p className="font-mono text-4xl font-extrabold break-all">{formatQuantityUnit(p.payload.quantity, p.material.unit)}</p>
          <p className="mt-1 text-xl font-semibold break-all">{p.material.code}</p>
          <p className="text-base text-muted-foreground">{p.material.name}</p>
          <p className="mt-2 text-lg">
            do <span className="font-mono text-2xl font-bold">{p.location.code}</span>
          </p>
          {p.supplierName && <p className="mt-2 text-base">Dostawca: {p.supplierName}</p>}
          {p.payload.document_ref && <p className="text-base break-all">Dokument: {p.payload.document_ref}</p>}
        </section>
        <Button type="button" className={BIG_PRIMARY} onClick={() => resume(p)}>
          Ponów (bez ryzyka duplikatu)
        </Button>
        <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={discardPending}>
          Porzuć
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        {pendingUnknown || submitting ? (
          <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">Dokończ przyjęcie</span>
        ) : (
          <BackLink />
        )}
        <h1 className="pr-3 text-xl font-bold">
          Przyjęcie <span className="text-base font-medium text-muted-foreground">· {STEP_NO[step]}/4</span>
        </h1>
      </header>

      {location && step !== "location" && step !== "done" && (
        <ContextRow
          label="Lokalizacja"
          value={location.code}
          sub={location.name}
          onChange={step === "summary" && (pendingUnknown || submitting) ? undefined : changeLocation}
        />
      )}
      {material && (step === "quantity" || step === "summary") && (
        <ContextRow
          label="Materiał"
          value={material.code}
          sub={`${material.name} · ${material.unit}`}
          onChange={step === "summary" && (pendingUnknown || submitting) ? undefined : () => setStep("material")}
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
          <MaterialPicker onSelect={pickMaterial} recent={recent} />
        </>
      )}

      {step === "quantity" && material && (
        <form onSubmit={goSummary} noValidate className="flex flex-col gap-4">
          <label htmlFor="qty" className="text-2xl font-bold">
            Ilość
          </label>
          <div className="flex items-center gap-3">
            <Input
              id="qty"
              value={qtyText}
              onChange={(e) => (setQtyText(e.target.value), setQtyError(null))}
              inputMode={material.allowsFraction ? "decimal" : "numeric"}
              autoComplete="off"
              autoFocus
              enterKeyHint="next"
              placeholder={material.allowsFraction ? "np. 2,5" : "np. 12"}
              aria-invalid={!!qtyError}
              aria-describedby={qtyError ? "qty-error" : undefined}
              className="h-20 min-w-0 flex-1 rounded-2xl px-4 text-right font-mono text-4xl font-bold"
            />
            <span className="shrink-0 text-2xl font-semibold">{material.unit}</span>
          </div>
          {!material.allowsFraction && <p className="text-muted-foreground">Tylko liczby całkowite (bez ułamków).</p>}
          {qtyError && (
            <p id="qty-error" role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
              {qtyError}
            </p>
          )}

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

          {submitError && (
            <div
              role="alert"
              className={
                submitError.kind === "network"
                  ? "rounded-xl bg-amber-100 p-4 text-base font-medium text-amber-900"
                  : "rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive"
              }
            >
              <p>{submitError.message}</p>
              {submitError.kind === "network" && (
                <p className="mt-1 font-normal">
                  Naciśnij „Spróbuj ponownie” — jeśli operacja już się zapisała, nie zostanie zdublowana.
                </p>
              )}
              {submitError.kind === "auth" && (
                <p className="mt-1 font-normal">
                  <Link href="/login" className="underline underline-offset-4">
                    Zaloguj się
                  </Link>{" "}
                  — po zalogowaniu wejdź w PRZYJĘCIE, a system zaproponuje dokończenie tej operacji.
                </p>
              )}
            </div>
          )}

          <Button type="button" className={BIG_PRIMARY} disabled={submitting}
            // Ponowienie: dokładnie zapisane żądanie (ten sam id i payload); pierwsze wysłanie: z bieżących danych.
            onClick={() => (pendingUnknown && pending ? void send(pending) : confirm())}
          >
            {submitting ? "Zapisywanie…" : pendingUnknown ? "Spróbuj ponownie" : "ZATWIERDŹ"}
          </Button>
          {pendingUnknown ? (
            <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={submitting} onClick={discardPending}>
              Porzuć — sprawdzę w ostatnich przyjęciach
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              className={BIG_SECONDARY}
              disabled={submitting}
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
            <p className="text-2xl font-bold">
              Przyjęto {formatQuantityUnit(result.quantity, material.unit)}
            </p>
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
          <Link
            href="/m"
            className="flex h-14 w-full items-center justify-center rounded-2xl border bg-background text-lg font-semibold active:bg-muted"
          >
            Zakończ
          </Link>
        </div>
      )}
    </div>
  );
}

function ContextRow({
  label,
  value,
  sub,
  onChange,
}: {
  label: string;
  value: string;
  sub?: string | null;
  onChange?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border bg-background px-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="font-mono text-xl font-bold break-all">{value}</div>
        {sub && <div className="truncate text-sm text-muted-foreground">{sub}</div>}
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="h-12 shrink-0 rounded-xl px-3 text-base font-medium underline underline-offset-4 active:bg-muted"
        >
          Zmień
        </button>
      )}
    </div>
  );
}
