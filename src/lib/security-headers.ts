// Nagłówki bezpieczeństwa dla wszystkich odpowiedzi.
// Źródła: next.config.ts (strony i route handlery), middleware.ts (odpowiedzi generowane w middleware,
// np. 401/403/415 i redirecty) oraz public/_headers (statyczne assety serwowane bez Workera).
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
