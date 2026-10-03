import { existsSync, readFileSync } from "node:fs";
import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { parseImport } from "@/modules/liczokno-import/formats";
import { aggregateLines } from "@/modules/liczokno-import/normalize";
import { readWorkbookRows } from "@/modules/liczokno-import/read-workbook";

// Test integracyjny parsera na prawdziwym pliku z LiczOkno (poza gitem — dane klienta i ceny). Bez pliku test jest
// pomijany. Asercje nie wypisują danych klienta poza tym, co konieczne.
const SAMPLE = "docs/przykladowy_wzor/PRZYKLADOWY_ZM_RW.xls";

describe.skipIf(!existsSync(SAMPLE))("parser na prawdziwym pliku LiczOkno (Lista materiałowa)", () => {
  async function load() {
    const buffer = readFileSync(SAMPLE);
    const file = new File([buffer], "PRZYKLADOWY_ZM_RW.xls");
    return parseImport(await readWorkbookRows(file as unknown as globalThis.File));
  }

  it("czyta nagłówek: nazwę zlecenia i datę", async () => {
    const parsed = await load();
    expect(parsed.formatId).toBe("liczokno-lista-materialowa");
    expect(parsed.orderNameHint?.startsWith("O_TP_")).toBe(true);
    expect(parsed.documentDate).toBe("2026-10-03");
  });

  it("pomija grupy, „Razem” i tabelę rabatów; sumuje kody; profile oznaczone", async () => {
    const parsed = await load();
    expect(parsed.lines.length).toBeGreaterThan(100);
    expect(parsed.lines.every((l) => l.quantity > 0 && l.unit !== "" && l.code !== "")).toBe(true);
    expect(parsed.lines.some((l) => /grupa rabatowa|razem/i.test(l.code))).toBe(false);
    expect(new Set(parsed.lines.map((l) => l.unit))).toEqual(new Set(["szt.", "m"]));

    const items = aggregateLines(parsed.lines);
    expect(items.length).toBeLessThan(parsed.lines.length); // są kody w kilku wierszach
    const p2102 = items.find((i) => i.key === "P2102 30/10/AR-RAL7016-FS/10/AR-RAL9016-MAT");
    expect(p2102).toBeDefined();
    expect(p2102!.quantity).toBe(44.2);
    expect(p2102!.unit).toBe("m");
    expect(p2102!.sourceRows.length).toBe(2);
    expect(p2102!.isProfile).toBe(true);
    expect(items.filter((i) => i.isProfile).length).toBeGreaterThan(0);
    expect(items.filter((i) => !i.isProfile).length).toBeGreaterThan(0);
    expect(items.some((i) => i.unitConflict)).toBe(false);
  });
});
