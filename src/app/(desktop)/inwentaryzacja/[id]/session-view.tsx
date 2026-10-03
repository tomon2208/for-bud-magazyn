"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CsvButton } from "@/components/csv-button";
import { UnresolvedAttemptAlert } from "@/components/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirmGuard } from "@/lib/confirm-guard";
import { pluralPl } from "@/lib/format";
import {
  submitApprove,
  submitSessionAction,
  type ApprovePayload,
  type SessionActionPayload,
} from "@/lib/inventory-client";
import { useOperationAttempt } from "@/lib/use-operation-attempt";
import {
  BLOCKED_REASON_LABELS,
  MAX_CANCEL_REASON_LENGTH,
  REVIEW_STATUS_LABELS,
  SESSION_STATUS_LABELS,
  SKIP_REASON_LABELS,
  isApprovable,
  overReservationAfterApprove,
  type ReviewStatus,
} from "@/lib/validation/inventory";
import { formatQuantity } from "@/lib/validation/stock";
import type { ApproveResultDto, CountEventDto, ReviewRowDto, SessionOverviewDto } from "@/server/inventory";

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
const fmt = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : "—");
const qty = (v: number | null) => (v === null ? "—" : formatQuantity(v));
const signed = (v: number | null) => (v === null ? "—" : v > 0 ? `+${formatQuantity(v)}` : v < 0 ? `−${formatQuantity(-v)}` : "0");

const STATUS_CLASS: Record<ReviewStatus, string> = {
  OK: "bg-emerald-50 text-emerald-900",
  DIFF: "bg-amber-100 text-amber-950",
  RECOUNT: "bg-rose-100 text-rose-900",
  APPROVED: "bg-teal-100 text-teal-900",
  MATCHED: "bg-emerald-100 text-emerald-900",
  UNCOUNTED: "bg-muted text-muted-foreground",
};
const EVENT_LABELS: Record<CountEventDto["kind"], string> = {
  COUNT: "Liczenie",
  REMOVE: "Usunięcie liczenia",
  RECOUNT: "Do ponownego policzenia",
  APPROVE: "Zatwierdzenie różnicy",
  MATCH: "Zgodne (zatwierdzone)",
};

type Filter = "ALL" | "TODO" | "DIFF" | "RECOUNT" | "UNCOUNTED" | "DONE";
const FILTERS: [Filter, string][] = [
  ["ALL", "Wszystkie"],
  ["TODO", "Do zatwierdzenia"],
  ["DIFF", "Z różnicą"],
  ["RECOUNT", "Do ponownego policzenia"],
  ["UNCOUNTED", "Niepoliczone"],
  ["DONE", "Zatwierdzone"],
];
function matches(f: Filter, r: ReviewRowDto): boolean {
  switch (f) {
    case "ALL":
      return true;
    case "TODO":
      return isApprovable(r);
    case "DIFF":
      return r.status === "DIFF";
    case "RECOUNT":
      return r.status === "RECOUNT";
    case "UNCOUNTED":
      return r.status === "UNCOUNTED";
    case "DONE":
      return r.status === "APPROVED" || r.status === "MATCHED";
  }
}

/**
 * Tabela zatwierdzania sesji. Zatwierdzenie zawsze wysyła JAWNĄ listę pozycji widocznych dla zatwierdzającego
 * (zaznaczone albo wszystkie „do zatwierdzenia”) — nowe liczenia z terminala nie wchodzą „w ciemno”. Baza i tak
 * sprawdza każdą pozycję pod blokadą (ruch po liczeniu → do ponownego policzenia, bez różnicy).
 */
export function SessionView({ overview, rows, events }: { overview: SessionOverviewDto; rows: ReviewRowDto[]; events: CountEventDto[] }) {
  const router = useRouter();
  const { session, locations } = overview;
  const open = session.status === "OPEN";
  const [filter, setFilter] = useState<Filter>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [result, setResult] = useState<ApproveResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [sessionAction, setSessionAction] = useState<"close" | "cancel" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const approveAtt = useOperationAttempt<ApprovePayload>();
  const actionAtt = useOperationAttempt<SessionActionPayload>();
  const guard = useConfirmGuard();

  const counted = locations.filter((l) => l.countedAt !== null);
  const uncounted = locations.filter((l) => l.countedAt === null);
  const approvable = rows.filter(isApprovable);
  const visible = rows.filter((r) => matches(filter, r));
  const hasApproved = rows.some((r) => r.status === "APPROVED" || r.status === "MATCHED");
  const pendingRows = rows.filter((r) => r.status === "DIFF" || r.status === "OK" || r.status === "RECOUNT");
  const counts = useMemo(() => {
    const c: Record<ReviewStatus, number> = { OK: 0, DIFF: 0, RECOUNT: 0, APPROVED: 0, MATCHED: 0, UNCOUNTED: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const confirmRows = confirming ? rows.filter((r) => r.countId && confirming.includes(r.countId)) : [];
  const confirmDiff = confirmRows.filter((r) => r.status === "DIFF");
  const overReserved = overReservationAfterApprove(confirmDiff);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startApprove(ids: string[]) {
    setError(null);
    setResult(null);
    if (ids.length === 0) {
      setError("Brak pozycji do zatwierdzenia.");
      return;
    }
    setConfirming(ids);
    guard.arm();
  }

  async function approve() {
    if (!confirming && !approveAtt.unresolved) return;
    setError(null);
    const res = await approveAtt.run(
      approveAtt.unresolved
        ? null
        : {
            client_request_id: "",
            count_ids: confirming ?? [],
            // Ilości, które widzi zatwierdzający — zmienione w międzyczasie liczenie baza pominie (COUNT_CHANGED).
            expected_counts: Object.fromEntries(confirmRows.map((r) => [r.countId!, r.countedQuantity ?? 0])),
          },
      submitApprove(session.id),
    );
    if (!res) return;
    if (res.kind === "ok") {
      setResult(res.data);
      setConfirming(null);
      setSelected(new Set());
      router.refresh();
    } else if (res.kind === "error") {
      setError(res.message);
      setConfirming(null);
    }
  }

  async function runSessionAction() {
    if (!sessionAction) return;
    setError(null);
    const res = await actionAtt.run(
      actionAtt.unresolved
        ? null
        : { client_request_id: "", ...(sessionAction === "cancel" ? { reason: cancelReason.trim() || null } : {}) },
      submitSessionAction(session.id, sessionAction),
    );
    if (!res) return;
    if (res.kind === "ok") {
      setSessionAction(null);
      router.refresh();
    } else if (res.kind === "error") {
      setError(res.message);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{session.name}</h1>
          <span className="rounded-md bg-muted px-2 py-0.5 text-sm font-semibold">{SESSION_STATUS_LABELS[session.status]}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Utworzona {fmt(session.createdAt)} przez {session.createdByName}
          {session.closedAt && ` · zamknięta ${fmt(session.closedAt)} (${session.closedByName ?? ""})`}
          {session.cancelledAt && ` · anulowana ${fmt(session.cancelledAt)} (${session.cancelledByName ?? ""})`}
          {session.cancelReason && ` — ${session.cancelReason}`}
        </p>
        {session.note && <p className="text-sm">{session.note}</p>}
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Policzone lokalizacje" value={`${counted.length} / ${locations.length}`} />
        <Stat label="Do zatwierdzenia" value={String(approvable.length)} hint={`w tym z różnicą: ${counts.DIFF}`} />
        <Stat label="Do ponownego policzenia" value={String(counts.RECOUNT)} hint="ruch po liczeniu — policz jeszcze raz" />
        <Stat label="Zatwierdzone" value={String(counts.APPROVED + counts.MATCHED)} hint={`w tym zgodnych: ${counts.MATCHED}`} />
      </section>

      {uncounted.length > 0 && (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Niepoliczone lokalizacje ({uncounted.length})</summary>
          <p className="mt-2 font-mono">{uncounted.map((l) => l.code).join(", ")}</p>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <CsvButton url={`/api/v1/inventory/sessions/${session.id}/export?onlyDiff=true`} label="CSV — różnice" onError={setCsvError} fallbackName="inwentaryzacja-roznice.csv" />
        <CsvButton url={`/api/v1/inventory/sessions/${session.id}/export`} label="CSV — wszystkie pozycje" onError={setCsvError} fallbackName="inwentaryzacja.csv" />
        {open && (
          <>
            <Button type="button" variant="outline" onClick={() => (setSessionAction("close"), guard.arm())} disabled={actionAtt.locked}>
              Zamknij sesję…
            </Button>
            {!hasApproved && (
              <Button type="button" variant="outline" onClick={() => (setSessionAction("cancel"), guard.arm())} disabled={actionAtt.locked}>
                Anuluj sesję…
              </Button>
            )}
          </>
        )}
      </div>
      {csvError && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {csvError}
        </p>
      )}

      {sessionAction && open && (
        <section role="alertdialog" aria-label="Potwierdzenie" className="space-y-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
          {sessionAction === "close" ? (
            <>
              <p className="font-semibold">Zamknąć sesję „{session.name}”?</p>
              {uncounted.length > 0 && (
                <p>
                  {uncounted.length} lokalizacji nie zostało policzonych — ich stany <span className="font-semibold">nie zostaną zmienione</span>{" "}
                  (system nie zeruje automatycznie).
                </p>
              )}
              {pendingRows.length > 0 && (
                <p>
                  {pendingRows.length} {pluralPl(pendingRows.length, "pozycja nie jest zatwierdzona", "pozycje nie są zatwierdzone", "pozycji nie jest zatwierdzonych")} (różnice, zgodne, do ponownego policzenia) — po zamknięciu nie będzie
                  można ich zatwierdzić.
                </p>
              )}
              {counts.UNCOUNTED > 0 && <p>{counts.UNCOUNTED} materiałów oczekiwanych w policzonych lokalizacjach nie zostało wpisanych.</p>}
            </>
          ) : (
            <>
              <p className="font-semibold">Anulować sesję „{session.name}”? Liczenia zostaną w historii, stany bez zmian.</p>
              <label className="block space-y-1">
                <span>Powód (opcjonalnie)</span>
                <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={MAX_CANCEL_REASON_LENGTH} disabled={actionAtt.locked} />
              </label>
            </>
          )}
          {actionAtt.unresolved && <UnresolvedAttemptAlert status={actionAtt.attempt.status} what="zmiana statusu" saved="została zapisana" listName="sesji" />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={(e) => guard.allow(e) && void runSessionAction()} disabled={actionAtt.sending}>
              {actionAtt.unresolved ? "Ponów (ten sam identyfikator)" : sessionAction === "close" ? "Tak, zamknij sesję" : "Tak, anuluj sesję"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={actionAtt.sending}
              onClick={() => (actionAtt.discard(), setSessionAction(null))}
            >
              {actionAtt.unresolved ? "Porzuć" : "Nie"}
            </Button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {result && <ApproveResult result={result} />}

      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => startApprove([...selected])} disabled={selected.size === 0 || approveAtt.locked || confirming !== null}>
            Zatwierdź zaznaczone ({selected.size})
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => startApprove(approvable.map((r) => r.countId!))}
            disabled={approvable.length === 0 || approveAtt.locked || confirming !== null}
          >
            Zatwierdź wszystkie do zatwierdzenia ({approvable.length})
          </Button>
        </div>
      )}

      {(confirming || approveAtt.unresolved) && open && (
        <section role="alertdialog" aria-label="Potwierdzenie zatwierdzenia" className="space-y-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-semibold">
            Zatwierdzić {confirmRows.length} {pluralPl(confirmRows.length, "pozycję", "pozycje", "pozycji")}? Różnice ({confirmDiff.length}) zostaną wprowadzone jako ruchy „Inwentaryzacja” w historii;
            pozycje zgodne ({confirmRows.length - confirmDiff.length}) zostaną oznaczone bez ruchu.
          </p>
          {confirmDiff.length > 0 && confirmDiff.length <= 15 && (
            <ul className="list-inside list-disc">
              {confirmDiff.map((r) => (
                <li key={r.countId}>
                  <span className="font-mono">{r.locationCode}</span> · <span className="font-mono">{r.materialCode}</span>: {qty(r.systemQuantity)} →{" "}
                  {qty(r.countedQuantity)} {r.unit} ({signed(r.difference)})
                </li>
              ))}
            </ul>
          )}
          <p>Jeśli od liczenia był ruch materiału w lokalizacji, pozycja zostanie pominięta jako „do ponownego policzenia”.</p>
          {overReserved.length > 0 && (
            <p role="alert" className="rounded-md bg-rose-100 p-2 text-rose-950">
              Uwaga — po zatwierdzeniu rezerwacje przekroczą stan (rezerwacje nie zmienią się automatycznie): {overReserved.join("; ")}.
            </p>
          )}
          {approveAtt.unresolved && <UnresolvedAttemptAlert status={approveAtt.attempt.status} what="zatwierdzenie" saved="zostało zapisane" listName="pozycji (odśwież stronę)" />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={(e) => guard.allow(e) && void approve()} disabled={approveAtt.sending}>
              {approveAtt.sending ? "Zatwierdzanie…" : approveAtt.unresolved ? "Ponów (ten sam identyfikator)" : "Tak, zatwierdź"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={approveAtt.sending}
              onClick={() => (approveAtt.discard(), setConfirming(null))}
            >
              {approveAtt.unresolved ? "Porzuć" : "Nie"}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Pokaż:</span>
          {FILTERS.map(([f, label]) => (
            <Button key={f} type="button" size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
              {label}
            </Button>
          ))}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                {open && <th className="w-8 px-2 py-2" aria-label="Zaznacz" />}
                <th className="px-3 py-2 font-medium">Lokalizacja</th>
                <th className="px-3 py-2 font-medium">Materiał</th>
                <th className="px-3 py-2 text-right font-medium">Stan systemowy (teraz)</th>
                <th className="px-3 py-2 text-right font-medium">Policzono</th>
                <th className="px-3 py-2 text-right font-medium">Różnica</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Liczył</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={open ? 8 : 7} className="px-3 py-4 text-center text-muted-foreground">
                    Brak pozycji.
                  </td>
                </tr>
              )}
              {visible.map((r) => (
                <tr key={r.countId ?? `${r.locationId}-${r.materialId}`} className="border-t align-top">
                  {open && (
                    <td className="px-2 py-2">
                      {isApprovable(r) && r.countId && (
                        <input
                          type="checkbox"
                          aria-label={`Zaznacz ${r.locationCode} ${r.materialCode}`}
                          checked={selected.has(r.countId)}
                          onChange={() => toggle(r.countId!)}
                          disabled={approveAtt.locked || confirming !== null}
                        />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono">
                    {r.locationCode}
                    {!r.locationActive && <div className="font-sans text-xs text-destructive">nieaktywna</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/materialy/${r.materialId}`} className="font-mono underline-offset-4 hover:underline">
                      {r.materialCode}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {r.materialName}
                      {!r.materialActive && <span className="text-destructive"> (nieaktywny)</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {qty(r.systemQuantity)} {r.unit}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.countedQuantity === null ? "—" : `${qty(r.countedQuantity)} ${r.unit}`}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.difference && r.difference < 0 ? "text-rose-700" : r.difference && r.difference > 0 ? "text-emerald-700" : ""}`}>
                    {r.status === "UNCOUNTED" || r.status === "RECOUNT" ? "—" : signed(r.difference)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[r.status]}`}>{REVIEW_STATUS_LABELS[r.status]}</span>
                    {r.blockedReason && <div className="mt-1 text-xs text-destructive">{BLOCKED_REASON_LABELS[r.blockedReason] ?? r.blockedReason}</div>}
                    {r.status === "UNCOUNTED" && <div className="mt-1 text-xs text-muted-foreground">oczekiwany, nie wpisany — stan bez zmian</div>}
                    {r.operationId && (
                      <div className="mt-1 text-xs">
                        <Link href={`/historia?operacja=${r.operationId}`} className="underline underline-offset-4">
                          operacja
                        </Link>
                        {r.operationReversed && (
                          <div className="text-rose-700">
                            cofnięta — aby policzyć ponownie, zamknij sesję i utwórz nową
                          </div>
                        )}
                      </div>
                    )}
                    {r.approvedAt && (
                      <div className="text-xs text-muted-foreground">
                        {fmt(r.approvedAt)}, {r.approvedByName}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.countedByName ?? "—"}
                    {r.countedAt && <div className="text-muted-foreground">{fmt(r.countedAt)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Historia liczeń ({events.length})</summary>
        {events.length === 0 ? (
          <p className="mt-2 text-muted-foreground">Brak zdarzeń.</p>
        ) : (
          <ul className="mt-2 divide-y">
            {events.slice(0, 300).map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-3 py-1">
                <span className="text-muted-foreground">{fmt(e.createdAt)}</span>
                <span className="font-medium">{EVENT_LABELS[e.kind]}</span>
                <span className="font-mono">
                  {e.locationCode} · {e.materialCode}
                </span>
                <span>
                  {e.kind === "COUNT"
                    ? `${e.previousQuantity === null ? "" : `${qty(e.previousQuantity)} → `}${qty(e.countedQuantity)} ${e.unit}`
                    : e.kind === "REMOVE"
                      ? `było ${qty(e.previousQuantity)} ${e.unit}`
                      : `${qty(e.countedQuantity)} ${e.unit}`}
                </span>
                <span className="text-muted-foreground">{e.userName}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function ApproveResult({ result }: { result: ApproveResultDto }) {
  return (
    <section role="status" className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
      <p className="font-semibold">
        Zatwierdzono: {result.approvedCount} {pluralPl(result.approvedCount, "różnicę", "różnice", "różnic")}, zgodnych: {result.matchedCount}.
        {result.idempotentReplay && " (To zatwierdzenie było już zapisane — nie zostało zdublowane.)"}
      </p>
      {result.operationId && (
        <p>
          <Link href={`/historia?operacja=${result.operationId}`} className="underline underline-offset-4">
            Pokaż operację w historii ruchów
          </Link>
        </p>
      )}
      {result.recount.length > 0 && (
        <p className="rounded-md bg-rose-100 p-2 text-rose-950">
          Pominięto — do ponownego policzenia (ruch po liczeniu): {result.recount.map((r) => `${r.locationCode} · ${r.materialCode}`).join(", ")}.
        </p>
      )}
      {result.skipped.length > 0 && (
        <ul className="rounded-md bg-amber-100 p-2 text-amber-950">
          {result.skipped.map((s) => (
            <li key={s.countId}>
              Pominięto {s.locationCode} · {s.materialCode}: {SKIP_REASON_LABELS[s.reason] ?? s.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
