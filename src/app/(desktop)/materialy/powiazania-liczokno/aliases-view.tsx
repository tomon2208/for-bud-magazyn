"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { NoticeBox } from "@/components/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi, useApiAction } from "@/lib/api-client";
import type { ImportAliasDto } from "@/server/import";

/** Tabela powiązań: kod z pliku → materiał albo „nie magazynujemy”; filtr po kodzie/materiale; usuwanie z potwierdzeniem. */
export function AliasesView({ items, total }: { items: ImportAliasDto[]; total: number }) {
  const { run, busy, notice } = useApiAction();
  const [q, setQ] = useState("");

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term === "") return items;
    return items.filter(
      (a) =>
        a.sourceCode.toLowerCase().includes(term) ||
        (a.materialCode ?? "").toLowerCase().includes(term) ||
        (a.materialName ?? "").toLowerCase().includes(term) ||
        (a.action === "IGNORE" && "nie magazynujemy".includes(term)),
    );
  }, [items, q]);

  function remove(a: ImportAliasDto) {
    const what =
      a.action === "IGNORE"
        ? `Usunąć oznaczenie „nie magazynujemy” dla kodu ${a.sourceCode}? Kolejne importy znów go nie pominą.`
        : `Usunąć powiązanie kodu ${a.sourceCode} z materiałem ${a.materialCode ?? ""}? Kolejne importy dopasują kod tylko wg kartoteki.`;
    if (!window.confirm(what)) return;
    void run(() => callApi(`/api/v1/import/aliases/${a.id}`, "DELETE"), `Usunięto wpis dla kodu ${a.sourceCode}`);
  }

  return (
    <div className="space-y-4">
      <NoticeBox notice={notice} />
      <Input
        type="search"
        aria-label="Filtruj powiązania"
        placeholder="Filtruj po kodzie z pliku lub materiale"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        maxLength={100}
        className="h-9 w-80"
      />
      {items.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">
          Brak powiązań. Pojawią się, gdy podczas importu wskażesz materiał dla nieznanego kodu albo oznaczysz kod jako „nie
          magazynujemy”.
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border p-6 text-center text-muted-foreground">Brak wyników dla filtra.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kod z pliku</TableHead>
                <TableHead>Powiązanie</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono break-all">{a.sourceCode}</TableCell>
                  <TableCell>
                    {a.action === "IGNORE" ? (
                      <Badge variant="secondary">nie magazynujemy</Badge>
                    ) : (
                      <>
                        {a.materialId ? (
                          <Link href={`/materialy/${a.materialId}`} className="font-mono underline underline-offset-4">
                            {a.materialCode}
                          </Link>
                        ) : (
                          "—"
                        )}
                        <span className="ml-2 text-sm text-muted-foreground">{a.materialName}</span>
                        {a.materialActive === false && <Badge variant="destructive" className="ml-2">nieaktywny</Badge>}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button type="button" variant="destructive" size="lg" disabled={busy} onClick={() => remove(a)}>
                      Usuń
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Wpisy: {visible.length} z {total}
        {total > items.length && ` (pokazano pierwsze ${items.length})`}
      </p>
    </div>
  );
}
