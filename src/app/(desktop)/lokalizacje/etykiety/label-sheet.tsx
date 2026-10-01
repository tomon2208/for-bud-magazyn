"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { qrPayloadForLocation } from "@/lib/validation/locations";

type Label = { id: string; code: string; name: string | null };

// Rozmiary etykiet (mm) na arkuszu A4 bez marginesów: kolumny × wiersze.
const SIZES = {
  "3x8": { label: "3 × 8 (24 etykiety, 70 × 37 mm)", cols: 3, rows: 8, w: 70, h: 37, qr: 33 },
  "2x5": { label: "2 × 5 (10 etykiet, 105 × 57 mm)", cols: 2, rows: 5, w: 105, h: 57, qr: 45 },
} as const;
type SizeKey = keyof typeof SIZES;

type QrMatrix = { size: number; path: string };

// Minimalna wielkość czcionki napisu (mm): znak ≈ 0,72 em, więc ≥ 3 mm wysokości znaku. Dłuższe kody zawijamy.
const MIN_CODE_FONT_MM = 4.2;
const QUIET_ZONE = 4; // moduły ciszy wokół QR (wymóg specyfikacji)

/** Macierz QR → ścieżka SVG (jeden kwadrat 1×1 na ciemny moduł). Korekcja błędów Q (~25%) — etykiety w hali się brudzą. */
async function buildMatrices(codes: string[]): Promise<Record<string, QrMatrix>> {
  const { default: qrcode } = await import("qrcode-generator"); // tylko w przeglądarce, poza bundlem Workera
  const result: Record<string, QrMatrix> = {};
  for (const code of codes) {
    const qr = qrcode(0, "Q");
    qr.addData(qrPayloadForLocation(code), "Byte"); // treść QR: L:<kod>; na etykiecie drukujemy sam kod
    qr.make();
    const size = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    }
    result[code] = { size, path };
  }
  return result;
}

export function LabelSheet({ locations }: { locations: Label[] }) {
  const [sizeKey, setSizeKey] = useState<SizeKey>("3x8");
  const [matrices, setMatrices] = useState<Record<string, QrMatrix> | null>(null);
  const size = SIZES[sizeKey];

  useEffect(() => {
    let cancelled = false;
    void buildMatrices(locations.map((l) => l.code)).then((m) => {
      if (!cancelled) setMatrices(m);
    });
    return () => {
      cancelled = true;
    };
  }, [locations]);

  const perPage = size.cols * size.rows;
  const pages: Label[][] = [];
  for (let i = 0; i < locations.length; i += perPage) pages.push(locations.slice(i, i + perPage));

  return (
    <div>
      <style>{`@media print { @page { size: A4 portrait; margin: 0; } body { background: #fff; } }`}</style>
      <div className="mb-6 flex flex-wrap items-center gap-4 print:hidden">
        <label className="flex items-center gap-2 text-sm">
          Rozmiar etykiety
          <select
            value={sizeKey}
            onChange={(e) => setSizeKey(e.target.value as SizeKey)}
            className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm"
          >
            {Object.entries(SIZES).map(([key, s]) => (
              <option key={key} value={key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" size="lg" disabled={!matrices} onClick={() => window.print()}>
          Drukuj ({locations.length})
        </Button>
        <p className="text-sm text-muted-foreground">
          W oknie drukowania wybierz A4, skalę 100% („Rzeczywisty rozmiar”) i wyłącz nagłówki/stopki.
        </p>
      </div>

      <div className="space-y-6 overflow-x-auto print:space-y-0 print:overflow-visible">
        {pages.map((page, index) => (
          <div
            key={index}
            className="grid bg-white text-black shadow print:shadow-none"
            style={{
              gridTemplateColumns: `repeat(${size.cols}, ${size.w}mm)`,
              gridAutoRows: `${size.h}mm`,
              width: `${size.cols * size.w}mm`,
              height: `${size.rows * size.h}mm`,
              breakAfter: index < pages.length - 1 ? "page" : "auto",
            }}
          >
            {page.map((loc) => {
              const m = matrices?.[loc.code];
              // Napis kodu: duży, mieści się w szerokości obok QR (znak monospace ≈ 0,62 em), ale nie mniejszy
              // niż MIN_CODE_FONT_MM — wtedy zawija się na kilka linii.
              const textW = size.w - size.qr - 6;
              const fontMm = Math.max(MIN_CODE_FONT_MM, Math.min(size.h * 0.3, textW / (loc.code.length * 0.62)));
              return (
                <div
                  key={loc.id}
                  className="box-border flex items-center gap-[1.5mm] overflow-hidden border border-dashed border-neutral-300 p-[2mm]"
                  style={{ width: `${size.w}mm`, height: `${size.h}mm` }}
                >
                  <div className="shrink-0" style={{ width: `${size.qr}mm`, height: `${size.qr}mm` }}>
                    {m && (
                      <svg
                        viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${m.size + 2 * QUIET_ZONE} ${m.size + 2 * QUIET_ZONE}`}
                        width="100%"
                        height="100%"
                        shapeRendering="crispEdges"
                        role="img"
                        aria-label={`Kod QR ${loc.code}`}
                      >
                        <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={m.size + 2 * QUIET_ZONE} height={m.size + 2 * QUIET_ZONE} fill="#fff" />
                        <path d={m.path} fill="#000" />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono leading-none font-bold break-all" style={{ fontSize: `${fontMm}mm` }}>
                      {loc.code}
                    </div>
                    {loc.name && (
                      <div className="mt-[1.5mm] leading-tight break-words" style={{ fontSize: `${Math.max(2.8, size.h * 0.09)}mm` }}>
                        {loc.name}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
