// Ochrona CSRF dla metod mutujących API (wzorzec dla wszystkich przyszłych endpointów, także stockowych).
// Czysta funkcja bez zależności od Next — używana w middleware (Edge) i w route handlerach (Node).
//
// Zasady:
// 1. Treść żądania (jeśli jest) musi mieć Content-Type: application/json → inaczej 415.
//    Formularz HTML z obcej strony nie wyśle application/json bez preflightu CORS.
// 2. Origin musi wskazywać ten sam host co żądanie → inaczej 403.
//    Bez nagłówka Origin akceptujemy tylko Sec-Fetch-Site: same-origin; brak obu → 403.

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type CsrfFailure = { status: 403 | 415; code: string; message: string };

type HeaderSource = { get(name: string): string | null };

function hasBody(method: string, headers: HeaderSource): boolean {
  if (method !== "DELETE") return true;
  const length = headers.get("content-length");
  return Boolean(headers.get("transfer-encoding")) || (length !== null && length !== "0");
}

function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime === "application/json";
}

/** Zwraca opis błędu albo null, gdy żądanie jest dozwolone. Metody niemutujące zawsze przechodzą. */
export function checkMutationRequest(req: {
  method: string;
  url: string;
  headers: HeaderSource;
}): CsrfFailure | null {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) return null;

  if (hasBody(method, req.headers) && !isJson(req.headers.get("content-type"))) {
    return { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Wymagany Content-Type: application/json" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { status: 403, code: "CSRF", message: "Niedozwolone źródło żądania" };
    }
    const allowed = new Set<string>([new URL(req.url).host]);
    const hostHeader = req.headers.get("host");
    if (hostHeader) allowed.add(hostHeader);
    if (!allowed.has(originHost)) {
      return { status: 403, code: "CSRF", message: "Niedozwolone źródło żądania" };
    }
    return null;
  }

  if (req.headers.get("sec-fetch-site") === "same-origin") return null;
  return { status: 403, code: "CSRF", message: "Niedozwolone źródło żądania" };
}
