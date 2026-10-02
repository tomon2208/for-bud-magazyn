// Eksport CSV: treść (separator, cytowanie, przecinek dziesiętny, neutralizacja formuł, kody ="0518")
// generuje baza (funkcja export_stock_csv — ADR 012), żeby nie zużywać CPU Workera. Tu zostaje tylko to,
// co robi Worker: BOM i znacznik czasu do nazwy pliku.

export const CSV_BOM = "﻿";

/** Znacznik czasu do nazwy pliku w strefie Europe/Warsaw: RRRR-MM-DD_GGMM. */
export function fileTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}${get("minute")}`;
}
