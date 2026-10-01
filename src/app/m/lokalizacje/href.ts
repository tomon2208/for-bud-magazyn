/** Adres ekranu lokalizacji. Segment jest kodowany (encodeURIComponent); strona dekoduje go decodeCodeParam. */
export function locationHref(code: string): string {
  return `/m/lokalizacje/${encodeURIComponent(code)}`;
}
