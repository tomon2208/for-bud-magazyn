"use client";

import Link from "next/link";
import { useState } from "react";
import { NoticeBox } from "@/components/form-parts";
import { MaterialPicker, type PickedMaterial } from "@/components/material-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction } from "@/lib/api-client";
import { formatQuantityUnit } from "@/lib/validation/stock";
import type { MaterialSubstituteDto } from "@/server/substitutes";

/**
 * Karta materiału — „Odpowiedniki” (Etap 12b): lista (kod, nazwa, jednostka, wolne), ADMIN: „Dodaj odpowiednik”
 * (wyszukiwarka aktywnych materiałów; ostrzeżenie o innej jednostce — przelicznik i tak 1:1) i „Usuń” z potwierdzeniem.
 * Relacja symetryczna (A↔B), nieprzechodnia.
 */
export function SubstitutesSection({
  material,
  items,
  canEdit,
}: {
  material: { id: string; code: string; unit: string; active: boolean };
  items: MaterialSubstituteDto[];
  canEdit: boolean;
}) {
  const { run, busy, notice, setNotice } = useApiAction();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<PickedMaterial | null>(null);

  function choose(m: PickedMaterial) {
    if (m.id === material.id) {
      setNotice({ kind: "error", text: "Materiał nie może być odpowiednikiem samego siebie" });
      return;
    }
    if (items.some((i) => i.materialId === m.id)) {
      setNotice({ kind: "error", text: `${m.code} jest już odpowiednikiem` });
      return;
    }
    setNotice(null);
    setPicked(m);
  }

  async function add() {
    if (!picked) return;
    const result = await run(
      () => callApi(`/api/v1/materials/${material.id}/substitutes`, "POST", { substitute_id: picked.id }),
      `Dodano odpowiednik ${picked.code} (działa w obie strony).`,
    );
    if (result?.ok) {
      setPicked(null);
      setAdding(false);
    }
  }

  async function remove(i: MaterialSubstituteDto) {
    if (
      !window.confirm(
        `Usunąć odpowiednik ${i.materialCode} materiału ${material.code}? Wcześniejsze wydania zamienników pozostaną rozliczone w historii.`,
      )
    ) {
      return;
    }
    await run(() => callApi(`/api/v1/materials/${material.id}/substitutes/${i.id}`, "DELETE"), `Usunięto odpowiednik ${i.materialCode}.`);
  }

  return (
    <section aria-labelledby="substitutes" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="substitutes" className="text-lg font-semibold">
          Odpowiedniki
        </h2>
        {canEdit && material.active && !adding && (
          <Button type="button" variant="outline" onClick={() => setAdding(true)} disabled={busy}>
            Dodaj odpowiednik
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Odpowiednik może zastąpić ten materiał w zapotrzebowaniu (przelicznik 1:1, w obie strony). Braki pokazują odpowiedniki na
        stanie, a wydanie odpowiednika na zlecenie zmniejsza „pozostało” oryginału.
      </p>
      <NoticeBox notice={notice} />

      {adding && (
        <div className="space-y-3 rounded-xl border p-4">
          {picked ? (
            <div className="space-y-2 text-sm">
              <p>
                Dodać <span className="font-mono font-semibold">{picked.code}</span> — {picked.name} jako odpowiednik{" "}
                <span className="font-mono">{material.code}</span>?
              </p>
              {picked.unit !== material.unit && (
                <p role="alert" className="rounded-md bg-amber-50 p-2 text-amber-950">
                  Uwaga: różne jednostki ({material.unit} / {picked.unit}) — przelicznik i tak wynosi 1:1 (1 {material.unit} = 1 {picked.unit}).
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={add} disabled={busy}>
                  Tak, dodaj
                </Button>
                <Button type="button" variant="outline" onClick={() => setPicked(null)} disabled={busy}>
                  Wybierz inny
                </Button>
              </div>
            </div>
          ) : (
            <MaterialPicker onSelect={choose} size="md" autoFocus />
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setPicked(null);
            }}
            disabled={busy}
          >
            Zamknij
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak odpowiedników.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kod</TableHead>
                <TableHead>Nazwa</TableHead>
                <TableHead>Jedn.</TableHead>
                <TableHead className="text-right">Wolne</TableHead>
                {canEdit && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono">
                    <Link href={`/materialy/${i.materialId}`} className="underline underline-offset-4">
                      {i.materialCode}
                    </Link>
                    {!i.active && (
                      <Badge variant="destructive" className="ml-2 font-sans">
                        nieaktywny
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{i.materialName}</TableCell>
                  <TableCell>
                    {i.unit}
                    {i.unit !== material.unit && <span className="ml-1 text-xs text-amber-800">(inna jednostka, 1:1)</span>}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatQuantityUnit(i.free, i.unit)}</TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button type="button" size="sm" variant="outline" onClick={() => remove(i)} disabled={busy}>
                        Usuń
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
