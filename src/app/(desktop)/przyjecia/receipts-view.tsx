"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Field, NoticeBox, SELECT_CLASS } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Notice } from "@/lib/api-client";
import {
  canEdit,
  discardAttempt,
  finishSend,
  initialAttempt,
  isUnresolved,
  startSend,
  type Attempt,
} from "@/lib/receipt-attempt";
import { fetchLocationByCode, submitReceipt, type ReceiptPayload } from "@/lib/stock-client";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";
import { parseScannedCode } from "@/lib/validation/locations";
import {
  MAX_DOCUMENT_REF_LENGTH,
  MAX_NOTE_LENGTH,
  checkQuantity,
  endSentence,
  formatQuantity,
  formatQuantityUnit,
} from "@/lib/validation/stock";
import type { MovementPage } from "@/server/stock";

type Filters = { q: string; from: string; to: string };
type Supplier = { id: string; name: string };

const DATE_TIME = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Warsaw",
});

function buildUrl(f: Filters, page: number) {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/przyjecia?${qs}` : "/przyjecia";
}

export function ReceiptsView({
  page,
  filters,
  canReceive,
  suppliers,
}: {
  page: MovementPage;
  filters: Filters;
  canReceive: boolean;
  suppliers: Supplier[];
}) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [formOpen, setFormOpen] = useState(false);
  const { q: appliedQ, from, to } = filters;

  useEffect(() => {
    if (q.trim() === appliedQ) return;
    const timer = setTimeout(() => router.replace(buildUrl({ q: q.trim(), from, to }, 1)), 300);
    return () => clearTimeout(timer);
  }, [q, appliedQ, from, to, router]);

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));

  return (
    <div className="space-y-6">
      {canReceive &&
        (formOpen ? (
          <DesktopReceiptForm suppliers={suppliers} onClose={() => setFormOpen(false)} onSaved={() => router.refresh()} />
        ) : (
          <Button type="button" onClick={() => setFormOpen(true)}>
            Nowe przyjęcie
          </Button>
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
        <label className="flex flex-col gap-1 text-sm">
          Od
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => router.replace(buildUrl({ q: q.trim(), from: e.target.value, to }, 1))}
            className={SELECT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Do
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => router.replace(buildUrl({ q: q.trim(), from, to: e.target.value }, 1))}
            className={SELECT_CLASS}
          />
        </label>
        {(from || to || appliedQ) && (
          <Button type="button" variant="outline" onClick={() => (setQ(""), router.replace("/przyjecia"))}>
            Wyczyść filtry
          </Button>
        )}
      </div>

      {page.items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          {from || to || appliedQ ? "Brak przyjęć dla podanych filtrów." : "Brak przyjęć."}
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
                <TableHead>Lokalizacja</TableHead>
                <TableHead>Dostawca</TableHead>
                <TableHead>Dokument</TableHead>
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
                    <span className="font-semibold">{formatQuantity(m.quantityDelta)}</span> {m.unit}
                  </TableCell>
                  <TableCell className="font-mono">{m.locationCode}</TableCell>
                  <TableCell>{m.supplierName ?? "—"}</TableCell>
                  <TableCell>
                    {m.documentRef ?? "—"}
                    {m.note && <div className="text-xs text-muted-foreground">{m.note}</div>}
                  </TableCell>
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
            onClick={() => router.push(buildUrl(filters, page.page - 1))}
          >
            Poprzednia
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={page.page >= totalPages}
            onClick={() => router.push(buildUrl(filters, page.page + 1))}
          >
            Następna
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Formularz przyjęcia dla ADMIN-a na desktopie — ten sam endpoint co terminal. */
function DesktopReceiptForm({
  suppliers,
  onClose,
  onSaved,
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [locationCode, setLocationCode] = useState("");
  const [material, setMaterial] = useState<PickedMaterial | null>(null);
  const [qty, setQty] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [documentRef, setDocumentRef] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  // Cykl próby zapisu (receipt-attempt): po wyniku nieznanym dane zamrożone, ponowienie = ten sam id i payload.
  const [attempt, setAttempt] = useState<Attempt<ReceiptPayload>>(initialAttempt);
  const attemptRef = useRef(attempt); // bieżący stan dla handlera (blokada podwójnego kliknięcia)
  const [lookingUp, setLookingUp] = useState(false);
  const [sentLabel, setSentLabel] = useState<{ code: string; unit: string; locationCode: string } | null>(null);

  const setAttemptBoth = (a: Attempt<ReceiptPayload>) => {
    attemptRef.current = a;
    setAttempt(a);
  };
  const locked = !canEdit(attempt) || lookingUp;
  const unresolved = isUnresolved(attempt);

  function chooseMaterial(m: PickedMaterial) {
    setNotice(null);
    setMaterial(m);
    setSupplierId(m.defaultSupplierId && suppliers.some((s) => s.id === m.defaultSupplierId) ? m.defaultSupplierId : "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = attemptRef.current;
    if (current.status === "sending" || lookingUp) return;

    let payload: ReceiptPayload | null = current.payload;
    let label = sentLabel;
    if (!isUnresolved(current)) {
      // Nowe dane: walidacja i rozpoznanie lokalizacji.
      const errs: Record<string, string> = {};
      const code = parseScannedCode(locationCode);
      if (!code) errs.location = "Podaj poprawny kod lokalizacji";
      if (!material) errs.material = "Wybierz materiał";
      const q = checkQuantity(qty, material?.allowsFraction ?? true);
      if (!q.ok) errs.quantity = q.message;
      setErrors(errs);
      if (Object.keys(errs).length > 0 || !code || !material || !q.ok) return;
      setLookingUp(true);
      setNotice(null);
      const loc = await fetchLocationByCode(code).finally(() => setLookingUp(false));
      if (loc.kind === "error") return setErrors({ location: loc.message });
      if (!loc.data.active) return setErrors({ location: "Lokalizacja jest nieaktywna" });
      payload = {
        client_request_id: "",
        location_id: loc.data.id,
        material_id: material.id,
        quantity: q.value,
        supplier_id: supplierId || null,
        document_ref: documentRef.trim() || null,
        note: note.trim() || null,
      };
      label = { code: material.code, unit: material.unit, locationCode: loc.data.code };
    }
    if (!payload || !label) return;

    const started = startSend(attemptRef.current, payload, () => crypto.randomUUID());
    if (!started) return;
    const body = { ...started.payload, client_request_id: started.requestId };
    setAttemptBoth({ ...started.next, payload: body });
    setSentLabel(label);
    setNotice(null);

    const res = await submitReceipt(body);
    const next = finishSend({ ...started.next, payload: body }, res.kind);
    setAttemptBoth(next);
    if (res.kind === "ok") {
      const replay = res.data.idempotentReplay ? " (operacja była już zapisana — bez duplikatu)" : "";
      setNotice({
        kind: "ok",
        text: endSentence(
          `Przyjęto ${formatQuantityUnit(res.data.quantity, label.unit)} ${label.code} do ${label.locationCode}. ` +
            `Stan w lokalizacji: ${formatQuantityUnit(res.data.newLocationQuantity, label.unit)}${replay}`,
        ),
      });
      setSentLabel(null);
      setMaterial(null);
      setQty("");
      setDocumentRef("");
      setNote("");
      onSaved();
    } else if (res.kind === "error") {
      setNotice({ kind: "error", text: res.message });
    }
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzone przyjęcie? Sprawdź na liście przyjęć, czy zostało zapisane.")) return;
    setAttemptBoth(discardAttempt());
    setSentLabel(null);
    setNotice({ kind: "ok", text: "Porzucono. Sprawdź na liście przyjęć poniżej, czy operacja została zapisana." });
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nowe przyjęcie</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <NoticeBox notice={notice} />
        {unresolved && (
          <div role="alert" className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">
            <p className="font-semibold">
              {attempt.status === "auth"
                ? "Sesja wygasła — zaloguj się w nowej karcie, potem ponów (ten sam identyfikator, bez duplikatu)."
                : "Nie wiadomo, czy przyjęcie zostało zapisane (brak odpowiedzi serwera)."}
            </p>
            <p>
              Dane są zablokowane. Ponów to samo żądanie — jeśli zostało już zapisane, nie zostanie zdublowane — albo
              porzuć je i sprawdź wynik na liście przyjęć.
            </p>
          </div>
        )}
        <form onSubmit={submit} noValidate className="grid gap-4 lg:grid-cols-2">
          <fieldset disabled={locked} className="contents">
            <div className="space-y-4">
              <Field id="rc-location" label="Lokalizacja (kod) *" error={errors.location}>
                <Input
                  id="rc-location"
                  value={locationCode}
                  onChange={(e) => (setNotice(null), setLocationCode(e.target.value))}
                  placeholder="np. A-03-02"
                  autoComplete="off"
                  className="font-mono uppercase"
                  aria-invalid={!!errors.location}
                />
              </Field>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Materiał *</span>
                {material ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                    <div>
                      <span className="font-mono font-semibold">{material.code}</span> · {material.name}{" "}
                      <span className="text-muted-foreground">({material.unit})</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => (setNotice(null), setMaterial(null))}>
                      Zmień
                    </Button>
                  </div>
                ) : locked ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <MaterialPicker onSelect={chooseMaterial} size="md" />
                )}
                {errors.material && <p className="text-xs text-destructive">{errors.material}</p>}
              </div>
            </div>
            <div className="space-y-4">
              <Field id="rc-qty" label={`Ilość *${material ? ` (${material.unit})` : ""}`} error={errors.quantity}>
                <Input
                  id="rc-qty"
                  value={qty}
                  onChange={(e) => (setNotice(null), setQty(e.target.value))}
                  inputMode={material?.allowsFraction === false ? "numeric" : "decimal"}
                  placeholder={material?.allowsFraction === false ? "liczba całkowita" : "np. 2,5"}
                  autoComplete="off"
                  aria-invalid={!!errors.quantity}
                />
              </Field>
              <Field id="rc-supplier" label="Dostawca">
                <select
                  id="rc-supplier"
                  value={supplierId}
                  onChange={(e) => (setNotice(null), setSupplierId(e.target.value))}
                  className={`${SELECT_CLASS} w-full`}
                >
                  <option value="">— brak / nieznany —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="rc-doc" label="Nr dokumentu (WZ / faktura)">
                <Input
                  id="rc-doc"
                  value={documentRef}
                  maxLength={MAX_DOCUMENT_REF_LENGTH}
                  onChange={(e) => (setNotice(null), setDocumentRef(e.target.value))}
                  autoComplete="off"
                />
              </Field>
              <Field id="rc-note" label="Notatka">
                <Input
                  id="rc-note"
                  value={note}
                  maxLength={MAX_NOTE_LENGTH}
                  onChange={(e) => (setNotice(null), setNote(e.target.value))}
                  autoComplete="off"
                />
              </Field>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button type="submit" disabled={attempt.status === "sending" || lookingUp}>
              {attempt.status === "sending" || lookingUp ? "Zapisywanie…" : unresolved ? "Ponów (ten sam id)" : "Przyjmij"}
            </Button>
            {unresolved ? (
              <Button type="button" variant="outline" onClick={discard}>
                Porzuć — sprawdzę na liście przyjęć
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={attempt.status === "sending" || lookingUp} onClick={onClose}>
                Zamknij
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
