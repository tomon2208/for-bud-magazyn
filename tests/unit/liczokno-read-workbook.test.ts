import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { parseImport } from "@/modules/liczokno-import/formats";
import { detectCsvSeparator, readWorkbookRows } from "@/modules/liczokno-import/read-workbook";
import { ImportParseError } from "@/modules/liczokno-import/types";

// readWorkbookRows na małych plikach CSV: separatory, przecinek dziesiętny, tytuł z przecinkami, kodowania.

const WIN1250: Record<string, number> = { ą: 0xb9, ć: 0xe6, ę: 0xea, ł: 0xb3, ń: 0xf1, ó: 0xf3, ś: 0x9c, ź: 0x9f, ż: 0xbf, Ł: 0xa3, Ś: 0x8c, Ż: 0xaf };
function win1250(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text).map((ch) => WIN1250[ch] ?? ch.charCodeAt(0)));
}
const fileOf = (name: string, bytes: Uint8Array | string) =>
  new File([typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes], name) as unknown as globalThis.File;

const TITLE = "Zlecenie: Okna, parter, piętro   Utworzono: 03.10.2026";
const csv = (sep: string, qty = "7,432") =>
  [
    [TITLE, "", "", ""],
    ["Kod elementu", "Opis", "Ilość", "Jednostka miary"],
    ["Okucia", "", "", ""],
    ["A1", "Narożnik, duży", "3", "szt."],
    ["P1", "Profil", qty, "m"],
  ]
    .map((r) => r.map((c) => (c.includes(sep) || c.includes('"') ? `"${c}"` : c)).join(sep))
    .join("\r\n");

describe("detectCsvSeparator", () => {
  it("wybiera najczęstszy separator z wiersza nagłówka, ignorując tytuł z przecinkami", () => {
    expect(detectCsvSeparator(csv(";"))).toBe(";");
    expect(detectCsvSeparator(csv(","))).toBe(",");
    expect(detectCsvSeparator(csv("\t"))).toBe("\t");
    expect(detectCsvSeparator("Kod elementu;Opis;Ilość")).toBe(";");
    expect(detectCsvSeparator("")).toBe(";");
  });
});

describe("readWorkbookRows — CSV", () => {
  for (const sep of [";", ",", "\t"]) {
    it(`separator ${JSON.stringify(sep)}: przecinek dziesiętny zostaje tekstem, tytuł z przecinkami i opis w cudzysłowie cali`, async () => {
      const rows = await readWorkbookRows(fileOf("lista.csv", csv(sep)));
      expect(rows[0][0]).toBe(TITLE);
      expect(rows[3]).toEqual(["A1", "Narożnik, duży", "3", "szt."]);
      expect(rows[4][2]).toBe("7,432");
      const parsed = parseImport(rows);
      expect(parsed.orderNameHint).toBe("Okna, parter, piętro");
      expect(parsed.lines.map((l) => [l.code, l.quantity, l.unit, l.group])).toEqual([
        ["A1", 3, "szt.", "Okucia"],
        ["P1", 7.432, "m", "Okucia"],
      ]);
    });
  }

  it("UTF-8 z polskimi znakami (także z BOM)", async () => {
    const text = csv(";").replace("Profil", "Ościeżnica żółta");
    const rows = await readWorkbookRows(fileOf("a.csv", `﻿${text}`));
    expect(rows[4][1]).toBe("Ościeżnica żółta");
    expect(parseImport(rows).lines).toHaveLength(2);
  });

  it("Windows-1250 (bajty spoza UTF-8) dekodowane poprawnie", async () => {
    const text = csv(";").replace("Narożnik", "Narożnik łączący").replace("Profil", "Ścieżka żółta");
    const rows = await readWorkbookRows(fileOf("w.csv", win1250(text)));
    expect(rows[3][1]).toBe("Narożnik łączący, duży");
    expect(rows[4][1]).toBe("Ścieżka żółta");
    expect(parseImport(rows).documentDate).toBe("2026-10-03");
  });

  it("błędy: złe rozszerzenie, pusty plik, za duży plik", async () => {
    await expect(readWorkbookRows(fileOf("a.txt", "x"))).rejects.toThrow(ImportParseError);
    await expect(readWorkbookRows(fileOf("a.csv", ""))).rejects.toThrow(/pusty/);
    const big = { name: "a.csv", size: 6 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as globalThis.File;
    await expect(readWorkbookRows(big)).rejects.toThrow(/za duży/);
  });
});
