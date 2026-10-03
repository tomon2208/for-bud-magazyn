"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { NoticeBox } from "@/components/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction, type ApiResult } from "@/lib/api-client";
import { ISSUABLE_STATUSES, type OrderStatus } from "@/lib/validation/orders";
import { MAX_RELEASE_REASON_LENGTH, suggestReserveQuantity } from "@/lib/validation/reservations";
import { checkQuantity, formatQuantity } from "@/lib/validation/stock";
import type { OrderReservationDto, ReservationEventDto } from "@/server/reservations";

const DATE = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });

const EVENT_LABELS: Record<ReservationEventDto["type"], string> = {
  RESERVE: "Zarezerwowano",
  RELEASE: "Zwolniono ręcznie",
  CONSUME: "Zużyto przy wydaniu",
  OVERRIDE: "Zabrano (wydanie mimo rezerwacji)",
  AUTO_RELEASE: "Zwolniono automatycznie",
  SUBSTITUTE_RELEASE: "Zwolniono (wydano zamiennik)",
};

const NETWORK = "Brak połączenia z serwerem";

type ReserveResult = { reserved: { materialCode: string; quantity: number }[]; notReserved: { materialCode: string; missing: number }[] };
type ReleaseResult = { released: { materialCode: string; quantity: number }[] };

/**
 * Sekcja „Rezerwacje” zlecenia (BIURO, ADMIN): „Zarezerwuj wszystko” (min(pozostało do zarezerwowania, wolne) dla
 * każdej pozycji), rezerwacja ręczna per pozycja, „Zwolnij” (część / całość materiału / całe zlecenie) z potwierdzeniem,
 * zwinięta historia. Rezerwacja jest globalna per materiał (bez lokalizacji).
 */
export function ReservationsSection({
  orderId,
  orderStatus,
  items,
  events,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  items: OrderReservationDto[];
  events: ReservationEventDto[];
}) {
  const { run, busy, notice } = useApiAction();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseQty, setReleaseQty] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  // Szczegółowy wynik („czego się nie dało”) — osobny komunikat obok stałego tekstu useApiAction.
  const [detail, setDetail] = useState<string | null>(null);
  // Idempotencja: ten sam identyfikator żądania przy ponowieniu po błędzie sieci (wynik nieznany).
  const pending = useRef<{ sig: string; id: string } | null>(null);

  const issuable = (ISSUABLE_STATUSES as readonly string[]).includes(orderStatus);
  const overReserved = items.filter((i) => i.overReserved);
  const anyReserved = items.some((i) => i.reserved > 0);
  const excessItems = items.filter((i) => i.excess > 0);
  const canAutoReserve = issuable && items.some((i) => i.toReserve > 0 && i.free > 0);

  function requestId(sig: string) {
    if (pending.current?.sig === sig) return pending.current.id;
    const id = crypto.randomUUID();
    pending.current = { sig, id };
    return id;
  }
  function settle(result: ApiResult | null) {
    if (result && (result.ok || result.message !== NETWORK)) pending.current = null;
  }

  async function reserveAll() {
    setDetail(null);
    const sig = "auto";
    const result = await run(
      () => callApi(`/api/v1/orders/${orderId}/reservations`, "POST", { client_request_id: requestId(sig) }),
      "Zarezerwowano.",
    );
    settle(result);
    if (result?.ok) {
      const d = result.data as ReserveResult;
      const parts = [
        d.reserved.length > 0
          ? `Zarezerwowano: ${d.reserved.map((r) => `${r.materialCode} ${formatQuantity(r.quantity)}`).join(", ")}.`
          : "Nic nie zarezerwowano.",
        d.notReserved.length > 0
          ? `Brak wolnego stanu: ${d.notReserved.map((r) => `${r.materialCode} (brakuje ${formatQuantity(r.missing)})`).join(", ")}.`
          : "",
      ];
      setDetail(parts.filter(Boolean).join(" "));
    }
  }

  async function reserveOne(i: OrderReservationDto) {
    const raw = qty[i.materialId] ?? String(suggestReserveQuantity(i.toReserve, i.free, i.allowsFraction)).replace(".", ",");
    const check = checkQuantity(raw, i.allowsFraction);
    if (!check.ok) return setRowError({ id: i.materialId, text: check.message });
    if (check.value > i.toReserve) return setRowError({ id: i.materialId, text: `Pozostało do zarezerwowania: ${formatQuantity(i.toReserve)}` });
    if (check.value > i.free) return setRowError({ id: i.materialId, text: `Wolne w magazynie: ${formatQuantity(i.free)}` });
    setRowError(null);
    setDetail(null);
    const sig = `one:${i.materialId}:${check.value}`;
    const result = await run(
      () =>
        callApi(`/api/v1/orders/${orderId}/reservations`, "POST", {
          client_request_id: requestId(sig),
          items: [{ material_id: i.materialId, quantity: check.value }],
        }),
      `Zarezerwowano ${formatQuantity(check.value)} ${i.unit} — ${i.materialCode}.`,
    );
    settle(result);
    if (result?.ok) {
      // L4: po sukcesie wracamy do podpowiedzi liczonej ze świeżych danych.
      setQty((q) => {
        const next = { ...q };
        delete next[i.materialId];
        return next;
      });
    }
  }

  async function releaseExcess() {
    setDetail(null);
    const list = excessItems.map((i) => `${i.materialCode}: ${formatQuantity(i.excess)} ${i.unit}`).join(", ");
    if (!window.confirm(`Zwolnić rezerwacje ponad zapotrzebowanie (${list})? Powód: „Nadmiar po wycofaniu listy”.`)) return;
    const result = await run(
      () => callApi(`/api/v1/orders/${orderId}/reservations/release-excess`, "POST", { client_request_id: requestId("excess") }),
      "Zwolniono nadmiar rezerwacji.",
    );
    settle(result);
    if (result?.ok) {
      const d = result.data as ReleaseResult;
      setDetail(`Zwolniono: ${d.released.map((r) => `${r.materialCode} ${formatQuantity(r.quantity)}`).join(", ")}.`);
    }
  }

  async function release(i: OrderReservationDto | null) {
    setDetail(null);
    let quantity: number | null = null;
    if (i && releaseQty.trim() !== "") {
      const check = checkQuantity(releaseQty, i.allowsFraction);
      if (!check.ok) return setRowError({ id: i.materialId, text: check.message });
      if (check.value > i.reserved) return setRowError({ id: i.materialId, text: `Zarezerwowano tylko ${formatQuantity(i.reserved)}` });
      quantity = check.value;
    }
    const reason = releaseReason.trim() || null;
    const what = i
      ? `${quantity === null ? "całą rezerwację" : `${formatQuantity(quantity)} ${i.unit}`} materiału ${i.materialCode}`
      : "WSZYSTKIE rezerwacje tego zlecenia";
    if (!window.confirm(`Zwolnić ${what}? Towar wróci do wolnego stanu i inne zlecenia będą mogły go użyć.`)) return;
    setRowError(null);
    const sig = `release:${i?.materialId ?? "*"}:${quantity ?? "*"}:${reason ?? ""}`;
    const result = await run(
      () =>
        callApi(`/api/v1/orders/${orderId}/reservations/release`, "POST", {
          client_request_id: requestId(sig),
          material_id: i?.materialId ?? null,
          quantity,
          reason,
        }),
      "Zwolniono rezerwację.",
    );
    settle(result);
    if (result?.ok) {
      const d = result.data as ReleaseResult;
      setDetail(`Zwolniono: ${d.released.map((r) => `${r.materialCode} ${formatQuantity(r.quantity)}`).join(", ")}.`);
      setReleasing(null);
      setReleaseQty("");
      setReleaseReason("");
    }
  }

  return (
    <section id="rezerwacje" className="space-y-3" aria-labelledby="res-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="res-title" className="text-lg font-semibold">
          Rezerwacje
        </h2>
        <div className="flex flex-wrap gap-2">
          {canAutoReserve && (
            <Button type="button" onClick={reserveAll} disabled={busy}>
              Zarezerwuj wszystko
            </Button>
          )}
          {anyReserved && (
            <Button type="button" variant="outline" onClick={() => release(null)} disabled={busy}>
              Zwolnij wszystkie
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Rezerwacja chroni towar przed wydaniem na inne zlecenia (dotyczy materiału, nie lokalizacji). „Zarezerwuj wszystko”
        rezerwuje dla każdej pozycji tyle, ile pozostało do zarezerwowania — ale nie więcej niż jest wolne. Wydanie na to
        zlecenie zużywa najpierw jego rezerwację. Zakończenie lub anulowanie zlecenia zwalnia rezerwacje automatycznie.
      </p>

      {excessItems.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
          <p>
            <strong>Zlecenie ma rezerwacje ponad nowe zapotrzebowanie:</strong>{" "}
            {excessItems.map((i) => `${i.materialCode}: ${formatQuantity(i.excess)} ${i.unit}`).join(", ")} — nic nie dzieje
            się automatycznie; zwolnij nadmiar, jeśli nie jest potrzebny.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={releaseExcess} disabled={busy}>
            Zwolnij nadmiar
          </Button>
        </div>
      )}

      {overReserved.length > 0 && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
          <strong>Rezerwacje przekraczają stan</strong> ({overReserved.map((i) => i.materialCode).join(", ")}) — po korekcie lub
          cofnięciu operacji w magazynie jest mniej, niż zarezerwowano dla wszystkich zleceń. System nie zmniejsza rezerwacji
          sam: zdecyduj, które zlecenie zwalnia rezerwację.
        </p>
      )}

      <NoticeBox notice={notice} />
      {detail && (
        <p role="status" className="rounded-md bg-muted p-3 text-sm">
          {detail}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak pozycji zapotrzebowania do zarezerwowania.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Materiał</TableHead>
                <TableHead className="text-right">Potrzebne</TableHead>
                <TableHead className="text-right">Wydano</TableHead>
                <TableHead className="text-right">Zarezerwowane</TableHead>
                <TableHead className="text-right">Do zarezerwowania</TableHead>
                <TableHead className="text-right">Wolne w magazynie</TableHead>
                <TableHead>Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => {
                const suggestion = suggestReserveQuantity(i.toReserve, i.free, i.allowsFraction);
                const canReserve = issuable && suggestion > 0;
                return (
                  <TableRow key={i.materialId} className={i.overReserved ? "bg-amber-50" : undefined}>
                    <TableCell>
                      <Link href={`/materialy/${i.materialId}`} className="font-mono underline underline-offset-4">
                        {i.materialCode}
                      </Link>
                      <div className="text-xs text-muted-foreground">{i.materialName}</div>
                      {i.excess > 0 && (
                        <div className="text-xs text-amber-800">Zarezerwowano o {formatQuantity(i.excess)} więcej niż pozostało do wydania</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {formatQuantity(i.needed)} {i.unit}
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(i.issued)}</TableCell>
                    <TableCell className="text-right font-semibold">{i.reserved > 0 ? formatQuantity(i.reserved) : "—"}</TableCell>
                    <TableCell className="text-right">{i.toReserve > 0 ? formatQuantity(i.toReserve) : "—"}</TableCell>
                    <TableCell className="text-right">
                      {formatQuantity(i.free)}
                      {i.overReserved && <div className="text-xs text-amber-800">rezerwacje &gt; stan</div>}
                    </TableCell>
                    <TableCell className="min-w-64">
                      <div className="flex flex-wrap items-center gap-2">
                        {canReserve && (
                          <>
                            <Input
                              aria-label={`Ilość do zarezerwowania — ${i.materialCode}`}
                              inputMode="decimal"
                              className="h-8 w-20"
                              value={qty[i.materialId] ?? String(suggestion).replace(".", ",")}
                              onChange={(e) => setQty((q) => ({ ...q, [i.materialId]: e.target.value }))}
                              disabled={busy}
                            />
                            <Button type="button" size="sm" onClick={() => reserveOne(i)} disabled={busy}>
                              Zarezerwuj
                            </Button>
                          </>
                        )}
                        {i.reserved > 0 && releasing !== i.materialId && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReleasing(i.materialId);
                              setReleaseQty("");
                              setReleaseReason("");
                              setRowError(null);
                            }}
                            disabled={busy}
                          >
                            Zwolnij…
                          </Button>
                        )}
                      </div>
                      {releasing === i.materialId && (
                        <div className="mt-2 space-y-2 rounded-lg border p-2">
                          <Input
                            aria-label="Ilość do zwolnienia (puste = całość)"
                            placeholder={`Ilość (puste = całość ${formatQuantity(i.reserved)})`}
                            inputMode="decimal"
                            className="h-8"
                            value={releaseQty}
                            onChange={(e) => setReleaseQty(e.target.value)}
                            disabled={busy}
                          />
                          <Input
                            aria-label="Powód (opcjonalnie)"
                            placeholder="Powód (opcjonalnie)"
                            maxLength={MAX_RELEASE_REASON_LENGTH}
                            className="h-8"
                            value={releaseReason}
                            onChange={(e) => setReleaseReason(e.target.value)}
                            disabled={busy}
                          />
                          <div className="flex gap-2">
                            <Button type="button" size="sm" variant="destructive" onClick={() => release(i)} disabled={busy}>
                              Zwolnij
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setReleasing(null)} disabled={busy}>
                              Anuluj
                            </Button>
                          </div>
                        </div>
                      )}
                      {rowError?.id === i.materialId && <p className="mt-1 text-xs text-destructive">{rowError.text}</p>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {events.length > 0 && (
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">Historia rezerwacji ({events.length})</summary>
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Zdarzenie</TableHead>
                  <TableHead>Materiał</TableHead>
                  <TableHead className="text-right">Zmiana</TableHead>
                  <TableHead className="text-right">Po zmianie</TableHead>
                  <TableHead>Kto</TableHead>
                  <TableHead>Powód / operacja</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{DATE.format(new Date(e.createdAt))}</TableCell>
                    <TableCell>{EVENT_LABELS[e.type] ?? e.type}</TableCell>
                    <TableCell className="font-mono">{e.materialCode}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {e.quantityDelta > 0 ? "+" : "−"}
                      {formatQuantity(Math.abs(e.quantityDelta))} {e.unit}
                    </TableCell>
                    <TableCell className="text-right">{formatQuantity(e.quantityAfter)}</TableCell>
                    <TableCell>{e.userName ?? "system"}</TableCell>
                    <TableCell className="text-sm">
                      {e.reason}
                      {e.type === "OVERRIDE" && (
                        <span className="text-muted-foreground"> — wydano {e.operationOrderName ? `na zlecenie ${e.operationOrderName}` : "bez zlecenia"}</span>
                      )}
                      {e.operationId && (
                        <Link href={`/historia?operacja=${e.operationId}`} className="ml-2 text-xs underline underline-offset-4">
                          operacja
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
      )}
    </section>
  );
}
