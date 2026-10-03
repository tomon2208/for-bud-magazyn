"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { pluralPl } from "@/lib/format";
import { fetchCountingLocation, submitCount, type SaveCountPayload } from "@/lib/inventory-client";
import { addRow, buildCountItems, initialRows, type CountRow } from "@/lib/inventory-count";
import { fetchLocationByCode } from "@/lib/stock-client";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import type { SaveCountResultDto, SessionLocationDto } from "@/server/inventory";
import { BackLink } from "../../back-link";
import { CodeScanner } from "../../code-scanner";
import { BIG_PRIMARY, BIG_ROW, BIG_SECONDARY, ContextRow, FinishLink, SubmitErrorAlert } from "../../wizard-parts";
import type { SubmitError } from "../../use-operation-submit";

/** Błędy, po których trzeba otworzyć lokalizację od nowa (świeże dane, nowa wersja i znacznik). */
const REOPEN_CODES = new Set(["COUNT_STALE", "LOCATION_COUNT_CHANGED", "ALREADY_APPROVED"]);

type Step = "pick" | "loading" | "count" | "confirm" | "done";
type Loc = { id: string; code: string; name: string | null };

const TIME = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric", timeZone: "Europe/Warsaw" });

/**
 * Liczenie lokalizacji „na ślepo” (ADR 015). Ekran NIE pokazuje stanów systemowych — tylko listę materiałów, których
 * system oczekuje w lokalizacji (bez ilości), oraz zapisane liczenia. Zapis całej lokalizacji naraz; wynik nieznany
 * (sieć / 5xx) → dane zamrożone, ponowienie tym samym client_request_id (bez duplikatu), jak w innych kreatorach.
 */
export function CountWizard({ session, locations }: { session: { id: string; name: string }; locations: SessionLocationDto[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [scanKey, setScanKey] = useState(0);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [location, setLocation] = useState<Loc | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [countedInfo, setCountedInfo] = useState<string | null>(null);
  const [rows, setRows] = useState<CountRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<{ items: SaveCountPayload["items"]; uncounted: CountRow[]; removed: CountRow[] } | null>(null);
  const [submitError, setSubmitError] = useState<(SubmitError & { stale?: boolean }) | null>(null);
  const [result, setResult] = useState<SaveCountResultDto | null>(null);
  const att = useOperationAttempt<SaveCountPayload>();
  const guard = useConfirmGuard();

  const counted = locations.filter((l) => l.countedAt !== null).length;
  const sorted = [...locations].sort((a, b) => Number(a.countedAt !== null) - Number(b.countedAt !== null) || a.code.localeCompare(b.code));
  const frozen = att.locked;

  useEffect(() => {
    if (!att.unresolved && !att.sending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [att.unresolved, att.sending]);

  async function open(loc: Loc) {
    setLocation(loc);
    setStep("loading");
    setMessage(null);
    setSubmitError(null);
    setErrors({});
    setAdding(false);
    setPending(null);
    const res = await fetchCountingLocation(session.id, loc.id);
    if (res.kind === "error") {
      setScanMessage(res.message);
      setScanKey((k) => k + 1);
      setStep("pick");
      return;
    }
    setRows(initialRows(res.data.items));
    setStartedAt(res.data.serverTime);
    setVersion(res.data.locationVersion);
    setCountedInfo(res.data.countedAt ? `Policzona ${TIME.format(new Date(res.data.countedAt))}${res.data.countedByName ? `, ${res.data.countedByName}` : ""}` : null);
    setStep("count");
  }

  async function onScanned(code: string) {
    setScanMessage(null);
    const inSession = locations.find((l) => l.code === code);
    if (inSession) {
      void open({ id: inSession.locationId, code: inSession.code, name: inSession.name });
      return;
    }
    const found = await fetchLocationByCode(code);
    setScanMessage(
      found.kind === "ok" ? `Lokalizacja ${found.data.code} nie należy do tej inwentaryzacji. Zeskanuj inną.` : found.message,
    );
    setScanKey((k) => k + 1);
  }

  function setText(materialId: string, text: string) {
    setRows((rs) => rs.map((r) => (r.materialId === materialId ? { ...r, text } : r)));
    setErrors((e) => {
      const next = { ...e };
      delete next[materialId];
      return next;
    });
  }

  function pickMaterial(m: PickedMaterial) {
    const r = addRow(rows, m);
    setAdding(false);
    if (r.existed) {
      setMessage(`${m.code} jest już na liście — wpisz ilość poniżej.`);
      return;
    }
    setRows(r.rows);
    setMessage(null);
  }

  function prepare() {
    const built = buildCountItems(rows);
    if (!built.ok) {
      setErrors(built.errors);
      setMessage("Popraw zaznaczone ilości.");
      return;
    }
    if (built.items.length === 0 && built.removed.length === 0 && rows.some((r) => r.state !== "APPROVED")) {
      setMessage("Wpisz policzoną ilość (0 = brak na półce).");
      return;
    }
    setMessage(null);
    setPending({ items: built.items, uncounted: built.uncounted, removed: built.removed });
    guard.arm();
    setStep("confirm");
  }

  async function save() {
    if (!location || !startedAt || version === null || !pending) return;
    setSubmitError(null);
    const res = await att.run({ client_request_id: "", started_at: startedAt, location_version: version, items: pending.items }, submitCount(session.id, location.id));
    if (!res) return;
    if (res.kind === "ok") {
      setResult(res.data);
      setStep("done");
      router.refresh();
      return;
    }
    if (res.kind === "network" || res.kind === "auth") {
      setSubmitError({ kind: res.kind, message: res.message });
      return;
    }
    setSubmitError({ kind: "domain", message: res.message, code: res.code, stale: REOPEN_CODES.has(res.code) });
  }

  function discard() {
    if (!window.confirm("Porzucić niepotwierdzony zapis? Po otwarciu lokalizacji sprawdzisz, czy liczenie zostało zapisane.")) return;
    att.discard();
    setSubmitError(null);
    setStep("count");
  }

  function backToPick() {
    setLocation(null);
    setRows([]);
    setResult(null);
    setScanMessage(null);
    setScanKey((k) => k + 1);
    setStep("pick");
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        {frozen ? (
          <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">Dokończ zapis</span>
        ) : (
          <BackLink href="/m/inwentaryzacja">Sesje</BackLink>
        )}
        <h1 className="min-w-0 truncate pr-3 text-xl font-bold">{session.name}</h1>
      </header>

      {step === "pick" && (
        <>
          <p className="rounded-2xl border bg-background px-4 py-3 text-lg">
            Policzone lokalizacje: <span className="font-bold">{counted}</span> z {locations.length}
          </p>
          <h2 className="text-2xl font-bold">Zeskanuj lokalizację</h2>
          <CodeScanner key={scanKey} onCode={(c) => void onScanned(c)} message={scanMessage} submitLabel="Dalej" />
          <h2 className="mt-2 text-lg font-semibold text-muted-foreground">albo wybierz z listy</h2>
          <ul className="flex flex-col gap-2">
            {sorted.map((l) => (
              <li key={l.locationId}>
                <button type="button" className={BIG_ROW} onClick={() => void open({ id: l.locationId, code: l.code, name: l.name })}>
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span className="font-mono text-xl font-bold break-all">{l.code}</span>
                    {l.countedAt ? (
                      <span className="shrink-0 rounded-md bg-emerald-100 px-2 text-sm font-semibold text-emerald-900">policzona</span>
                    ) : (
                      <span className="shrink-0 rounded-md bg-muted px-2 text-sm font-semibold">do policzenia</span>
                    )}
                  </span>
                  {(l.name || l.countedAt) && (
                    <span className="text-base text-muted-foreground">
                      {l.name}
                      {l.name && l.countedAt ? " · " : ""}
                      {l.countedAt && `${TIME.format(new Date(l.countedAt))}${l.countedByName ? `, ${l.countedByName}` : ""}`}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {step === "loading" && location && (
        <p className="rounded-xl bg-muted p-4 text-lg">Wczytywanie lokalizacji {location.code}…</p>
      )}

      {(step === "count" || step === "confirm") && location && (
        <>
          <ContextRow
            label="Lokalizacja"
            value={location.code}
            sub={countedInfo ?? location.name}
            onChange={frozen ? undefined : backToPick}
          />

          {step === "count" && (
            <>
              <p className="text-base text-muted-foreground">
                Policz towar na półce i wpisz ilości. <span className="font-semibold text-foreground">0</span> = brak na
                półce. Puste pole = nie policzono.
              </p>
              {rows.length === 0 && (
                <p className="rounded-xl border bg-background p-4 text-lg">
                  System nie oczekuje tu żadnego materiału. Jeśli coś leży na półce — dodaj materiał.
                </p>
              )}
              <ul className="flex flex-col gap-3">
                {rows.map((r) => (
                  <li key={r.materialId} className="rounded-2xl border bg-background p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-lg font-bold break-all">{r.code}</span>
                      <RowBadge r={r} />
                    </div>
                    <div className="text-base text-muted-foreground">
                      {r.name}
                      {!r.active && <span className="text-destructive"> (nieaktywny)</span>}
                    </div>
                    {r.state === "APPROVED" ? (
                      <p className="mt-2 text-lg">
                        Zatwierdzone: <span className="font-bold">{r.text || "—"}</span> {r.unit}
                      </p>
                    ) : (
                      <div className="mt-2 flex items-center gap-3">
                        <Input
                          value={r.text}
                          onChange={(e) => setText(r.materialId, e.target.value)}
                          inputMode={r.allowsFraction ? "decimal" : "numeric"}
                          autoComplete="off"
                          enterKeyHint="next"
                          placeholder={r.state === "RECOUNT" ? "policz ponownie" : "ilość"}
                          aria-label={`Policzona ilość ${r.code}`}
                          aria-invalid={!!errors[r.materialId]}
                          className="h-16 min-w-0 flex-1 rounded-xl px-4 text-right font-mono text-3xl font-bold"
                        />
                        <span className="w-16 shrink-0 text-xl font-semibold">{r.unit}</span>
                      </div>
                    )}
                    {errors[r.materialId] && (
                      <p role="alert" className="mt-2 rounded-lg bg-destructive/10 p-2 text-base font-medium text-destructive">
                        {errors[r.materialId]}
                      </p>
                    )}
                    {r.added && (
                      <button
                        type="button"
                        className="mt-2 h-12 rounded-xl px-3 text-base font-medium underline underline-offset-4 active:bg-muted"
                        onClick={() => setRows((rs) => rs.filter((x) => x.materialId !== r.materialId))}
                      >
                        Usuń z listy
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {adding ? (
                <section className="flex flex-col gap-3 rounded-2xl border bg-background p-3">
                  <h2 className="text-xl font-bold">Dodaj inny materiał</h2>
                  <MaterialPicker onSelect={pickMaterial} autoFocus />
                  <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => setAdding(false)}>
                    Anuluj dodawanie
                  </Button>
                </section>
              ) : (
                <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={() => setAdding(true)}>
                  + Dodaj inny materiał
                </Button>
              )}

              {message && (
                <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
                  {message}
                </p>
              )}
              <Button type="button" className={BIG_PRIMARY} onClick={prepare}>
                Dalej
              </Button>
            </>
          )}

          {step === "confirm" && pending && (
            <div className="flex flex-col gap-4">
              <section className="rounded-2xl border bg-background p-4">
                <p className="text-lg">
                  Zapisujesz liczenie: <span className="font-bold">{pending.items.length}</span>{" "}
                  {pluralPl(pending.items.length, "pozycja", "pozycje", "pozycji")}.
                </p>
                <ul className="mt-2 divide-y">
                  {pending.items.map((i) => {
                    const r = rows.find((x) => x.materialId === i.material_id);
                    return (
                      <li key={i.material_id} className="flex items-baseline justify-between gap-3 py-1.5">
                        <span className="font-mono font-bold break-all">{r?.code}</span>
                        <span className="shrink-0 text-lg font-bold whitespace-nowrap">
                          {r?.text.trim()} {r?.unit}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
              {pending.uncounted.length > 0 && (
                <p className="rounded-xl bg-amber-100 p-4 text-base text-amber-950">
                  Bez ilości (zostaną <span className="font-semibold">niepoliczone</span>, nie zerowane):{" "}
                  {pending.uncounted.map((r) => r.code).join(", ")}. Jeśli tego towaru nie ma na półce — wróć i wpisz 0.
                </p>
              )}
              {pending.removed.length > 0 && (
                <p className="rounded-xl bg-amber-100 p-4 text-base text-amber-950">
                  Puste pola — wcześniejsze liczenie zostanie usunięte: {pending.removed.map((r) => r.code).join(", ")}.
                </p>
              )}

              {submitError && <SubmitErrorAlert error={submitError} menuLabel="INWENTARYZACJA" />}

              {submitError?.stale ? (
                <Button type="button" className={BIG_PRIMARY} onClick={() => location && void open(location)}>
                  Otwórz lokalizację ponownie
                </Button>
              ) : (
                <Button
                  type="button"
                  className={BIG_PRIMARY}
                  disabled={att.sending}
                  onClick={(e) => guard.allow(e) && void save()}
                >
                  {att.sending ? "Zapisywanie…" : att.unresolved ? "Spróbuj ponownie" : "ZAPISZ LOKALIZACJĘ"}
                </Button>
              )}
              {att.unresolved ? (
                <Button type="button" variant="outline" className={BIG_SECONDARY} disabled={att.sending} onClick={discard}>
                  Porzuć — sprawdzę po ponownym otwarciu
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className={BIG_SECONDARY}
                  disabled={att.sending}
                  onClick={() => (setSubmitError(null), setStep("count"))}
                >
                  Popraw ilości
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {step === "done" && location && result && (
        <div className="flex flex-col gap-4">
          <section role="status" className="rounded-2xl bg-emerald-100 p-5 text-center text-emerald-950">
            <p className="text-2xl font-bold">Zapisano liczenie</p>
            <p className="mt-1 font-mono text-2xl font-bold">{location.code}</p>
            <p className="mt-2 text-lg">
              Pozycji: {result.saved}
              {result.removed > 0 && ` · usunięto: ${result.removed}`}
            </p>
            {result.idempotentReplay && <p className="mt-2 text-base">To liczenie było już zapisane — nie zostało zdublowane.</p>}
          </section>
          <Button type="button" className={BIG_PRIMARY} onClick={backToPick}>
            Następna lokalizacja
          </Button>
          <FinishLink />
        </div>
      )}
    </div>
  );
}

function RowBadge({ r }: { r: CountRow }) {
  if (r.state === "APPROVED") return <span className="shrink-0 rounded-md bg-emerald-100 px-2 text-sm font-semibold text-emerald-900">zatwierdzone</span>;
  if (r.state === "RECOUNT") return <span className="shrink-0 rounded-md bg-amber-100 px-2 text-sm font-semibold text-amber-900">policz ponownie</span>;
  if (r.state === "COUNTED") return <span className="shrink-0 rounded-md bg-sky-100 px-2 text-sm font-semibold text-sky-900">policzone</span>;
  if (r.added) return <span className="shrink-0 rounded-md bg-violet-100 px-2 text-sm font-semibold text-violet-900">dodany</span>;
  return <span className="shrink-0 rounded-md bg-muted px-2 text-sm font-semibold">oczekiwany</span>;
}
