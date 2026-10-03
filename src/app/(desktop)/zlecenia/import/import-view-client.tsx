"use client";

import dynamic from "next/dynamic";

// Widok importu LiczOkno ładowany WYŁĄCZNIE w przeglądarce (ssr: false): ani komponent, ani SheetJS (dynamiczny
// import w read-workbook.ts) nie trafiają do bundla serwerowego/Workera (limit 3 MiB, PLAN sekcja 0).
export const ImportViewClient = dynamic(() => import("./import-view").then((m) => m.ImportView), {
  ssr: false,
  loading: () => (
    <p role="status" className="text-sm text-muted-foreground">
      Ładowanie importu…
    </p>
  ),
});
