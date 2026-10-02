import { describe, expect, it } from "vitest";
import { CSV_BOM, fileTimestamp } from "@/lib/csv";
import { stockCsvFilename } from "@/server/overview";

// Treść CSV (cytowanie, injection, kody ="0518", liczby) generuje baza — testy w tests/db/dashboard.test.ts.

describe("BOM", () => {
  it("koduje się jako EF BB BF (UTF-8)", () => {
    const bytes = new TextEncoder().encode(CSV_BOM + "Łódź");
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("Łódź");
  });
});

describe("fileTimestamp", () => {
  it("strefa Europe/Warsaw: lato (CEST) i zima (CET)", () => {
    expect(fileTimestamp(new Date("2026-07-01T10:05:00Z"))).toBe("2026-07-01_1205");
    expect(fileTimestamp(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16_0030");
  });

  it("nazwa pliku: wariant + znacznik czasu", () => {
    const now = new Date("2026-10-02T08:07:00Z");
    expect(stockCsvFilename("location", now)).toBe("stany-lokalizacje_2026-10-02_1007.csv");
    expect(stockCsvFilename("material", now)).toBe("stany-materialy_2026-10-02_1007.csv");
  });
});
