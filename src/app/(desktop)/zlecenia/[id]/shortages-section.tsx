"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Field, NoticeBox, SELECT_CLASS } from "@/components/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction } from "@/lib/api-client";
import { substituteSplit, type SubstituteOption } from "@/lib/substitutes";
import { ISSUABLE_STATUSES, type OrderStatus } from "@/lib/validation/orders";
import { MAX_SUBSTITUTE_REASON_LENGTH } from "@/lib/validation/requirements";
import { formatQuantity } from "@/lib/validation/stock";
import type { OrderShortageDto, RequirementDto } from "@/server/requirements";

const NETWORK = "Brak połączenia z serwerem";

type Pending = { row: OrderShortageDto; sub: SubstituteOption };

/**
 * Sekcja „Braki zlecenia” (BIURO, ADMIN). Etap 12b: przy pozycji z brakiem — odpowiedniki na stanie („brak XXX, ale
 * jest odpowiednik YYY: N”) i „Podmień” (wycofanie listy + poprawiona kopia z YYY zamiast XXX, atomowo w bazie).
 */
export function ShortagesSection({
  orderStatus,
  rows,
  requirements,
}: {
  orderStatus: OrderStatus;
  rows: OrderShortageDto[];
  requirements: RequirementDto[];
}) {
  const { run, busy, notice, setNotice } = useApiAction();
  const [pending, setPending] = useState<Pending | null>(null);
  const [listId, setListId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Idempotencja: ten sam identyfikator przy ponowieniu IDENTYCZNEJ podmiany po błędzie sieci.
  const request = useRef<{ sig: string; id: string } | null>(null);

  const issuable = (ISSUABLE_STATUSES as readonly string[]).includes(orderStatus);
  const active = requirements.filter((r) => r.status === "ACTIVE");
  const listsWith = (materialId: string) => active.filter((r) => r.items.some((i) => i.materialId === materialId));

  function open(row: OrderShortageDto, sub: SubstituteOption) {
    const lists = listsWith(row.materialId);
    setPending({ row, sub });
    setListId(lists.length === 1 ? lists[0].id : "");
    setReason("");
    setError(null);
  }

  async function confirm() {
    if (!pending) return;
    if (!listId) return setError("Wybierz listę, na której podmienić pozycję");
    const trimmed = reason.trim();
    if (trimmed.length > MAX_SUBSTITUTE_REASON_LENGTH) return setError(`Powód: maksymalnie ${MAX_SUBSTITUTE_REASON_LENGTH} znaków`);
    setError(null);
    const sig = `${listId}|${pending.row.materialId}|${pending.sub.materialId}|${trimmed}`;
    if (request.current?.sig !== sig) request.current = { sig, id: crypto.randomUUID() };
    const { row, sub } = pending;
    const result = await run(
      () =>
        callApi(`/api/v1/requirements/${listId}/substitute`, "POST", {
          client_request_id: request.current!.id,
          from_material_id: row.materialId,
          to_material_id: sub.materialId,
          reason: trimmed || null,
        }),
      `Podmieniono ${row.materialCode} → ${sub.code}. Poprzednia lista została wycofana, utworzono poprawioną kopię.` +
        (row.reserved > 0 ? ` Rezerwacja ${row.materialCode} została — zwolnij nadmiar w sekcji Rezerwacje.` : ""),
    );
    if (result && (result.ok || result.message !== NETWORK)) request.current = null;
    if (result?.ok) {
      // L4: ilości z serwera (podział liczony pod blokadami w bazie, może różnić się od podglądu).
      const d = result.data as { movedQuantity: number | null; keptQuantity: number | null };
      const moved = d.movedQuantity ?? 0;
      const kept = d.keptQuantity ?? 0;
      setNotice({
        kind: "ok",
        text:
          `Podmieniono ${row.materialCode} → ${sub.code}: ${formatQuantity(moved)} ${sub.unit} ${sub.code} zamiast ${row.materialCode}` +
          (kept > 0 ? `; już wydane ${formatQuantity(kept)} ${row.unit} ${row.materialCode} zostaje na liście` : "") +
          ". Poprzednia lista została wycofana, utworzono poprawioną kopię." +
          (row.reserved > 0 ? ` Rezerwacja ${row.materialCode} została — zwolnij nadmiar w sekcji Rezerwacje.` : ""),
      });
      setPending(null);
    }
  }

  const list = pending ? active.find((r) => r.id === listId) : undefined;
  const item = pending && list ? list.items.find((i) => i.materialId === pending.row.materialId) : undefined;
  const split = pending && item ? substituteSplit(item.quantity, pending.row.needed, pending.row.issued) : null;

  return (
    <section id="braki" className="space-y-3" aria-labelledby="shortages-title">
      <h2 id="shortages-title" className="text-lg font-semibold">
        Braki zlecenia
      </h2>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
        „Dostępne” = wolne w magazynie (wspólne dla wszystkich zleceń, po odjęciu rezerwacji) + rezerwacja tego zlecenia.
        Wolny stan może pokrywać kilka zleceń naraz — zarezerwuj, aby go zabezpieczyć. Łączne braki do zamówienia pokazuje
        strona{" "}
        <Link href="/braki" className="font-medium underline underline-offset-4">
          Braki
        </Link>
        . Przy brakach widać odpowiedniki na stanie (przelicznik 1:1) — „Podmień” zamienia pozycję listy na odpowiednik.
      </p>
      <NoticeBox notice={notice} />
      {rows.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak aktywnych list zapotrzebowania.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kod</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Jedn.</TableHead>
                <TableHead className="text-right">Potrzebne</TableHead>
                <TableHead className="text-right">Wydano</TableHead>
                <TableHead className="text-right">Pozostało</TableHead>
                <TableHead className="text-right">Zarezerwowane</TableHead>
                <TableHead className="text-right">Wolne</TableHead>
                <TableHead className="text-right">Dostępne</TableHead>
                <TableHead className="text-right">Brakuje</TableHead>
                <TableHead>Odpowiedniki na stanie</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const subs = r.shortage > 0 ? r.substitutes.filter((s) => s.available > 0) : [];
                return (
                  <TableRow key={r.materialId} className={r.shortage > 0 ? "bg-destructive/10" : undefined}>
                    <TableCell className="font-mono">
                      <Link href={`/materialy/${r.materialId}`} className="underline underline-offset-4">
                        {r.materialCode}
                      </Link>
                    </TableCell>
                    <TableCell>{r.materialName}</TableCell>
                    <TableCell>{r.unit}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.needed)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.issued)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.remaining)}</TableCell>
                    <TableCell className="text-right">{r.reserved > 0 ? formatQuantity(r.reserved) : "—"}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.free)}</TableCell>
                    <TableCell className="text-right">{formatQuantity(r.available)}</TableCell>
                    <TableCell className={`text-right font-semibold ${r.shortage > 0 ? "text-destructive" : ""}`}>
                      {r.shortage > 0 ? formatQuantity(r.shortage) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {subs.length === 0 ? (
                        <span className="text-muted-foreground">{r.shortage > 0 && r.substitutes.length > 0 ? "brak na stanie" : ""}</span>
                      ) : (
                        <ul className="space-y-1">
                          {subs.map((s) => (
                            <li key={s.materialId} className="flex flex-wrap items-center gap-2">
                              <span>
                                <Link href={`/materialy/${s.materialId}`} className="font-mono underline underline-offset-4">
                                  {s.code}
                                </Link>{" "}
                                — dostępne {formatQuantity(s.available)} {s.unit}
                                {s.unit !== r.unit && <span className="text-amber-800"> (inna jednostka, 1:1)</span>}
                              </span>
                              {issuable && listsWith(r.materialId).length > 0 && (
                                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => open(r, s)}>
                                  Podmień
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {pending && (
        <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="dialog" aria-label="Podmień pozycję">
          <p className="font-medium">
            Podmień {pending.row.materialCode} → {pending.sub.code} ({pending.sub.name})
          </p>
          {listsWith(pending.row.materialId).length > 1 && (
            <Field id="subst-list" label="Lista zapotrzebowania">
              <select id="subst-list" className={SELECT_CLASS} value={listId} onChange={(e) => setListId(e.target.value)} disabled={busy}>
                <option value="">— wybierz listę —</option>
                {listsWith(pending.row.materialId).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({formatQuantity(l.items.find((i) => i.materialId === pending.row.materialId)?.quantity ?? 0)} {pending.row.unit})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {item && split && (
            <p>
              Lista „{list?.name}” zostanie wycofana z powodem „Podmiana {pending.row.materialCode} → {pending.sub.code}” i zastąpiona
              kopią, w której {formatQuantity(split.move)} {pending.row.unit} {pending.row.materialCode} zamienia się na{" "}
              {formatQuantity(split.move)} {pending.sub.unit} {pending.sub.code} (1:1).
              {split.keep > 0 && ` Już wydane ${formatQuantity(split.keep)} ${pending.row.unit} ${pending.row.materialCode} zostaje na liście.`}
              {split.move <= 0 && " Ta pozycja jest już w całości wydana — nie ma czego podmieniać."}
            </p>
          )}
          {pending.row.reserved > 0 && (
            <p>
              Rezerwacja {pending.row.materialCode} na tym zleceniu ({formatQuantity(pending.row.reserved)} {pending.row.unit}) zostaje — po
              podmianie możesz ją zwolnić przyciskiem „Zwolnij nadmiar” w sekcji Rezerwacje.
            </p>
          )}
          {pending.sub.unit !== pending.row.unit && (
            <p className="font-medium">Uwaga: jednostki są różne ({pending.row.unit} / {pending.sub.unit}) — przelicznik i tak wynosi 1:1.</p>
          )}
          <Field id="subst-reason" label="Powód (opcjonalnie)" error={error ?? undefined}>
            <Input
              id="subst-reason"
              value={reason}
              maxLength={MAX_SUBSTITUTE_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              placeholder="np. brak u dostawcy"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={confirm} disabled={busy || !listId || (split !== null && split.move <= 0)}>
              Tak, podmień
            </Button>
            <Button type="button" variant="outline" onClick={() => setPending(null)} disabled={busy}>
              Anuluj
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
