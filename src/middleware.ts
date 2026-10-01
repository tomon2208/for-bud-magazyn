import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { checkMutationRequest } from "@/lib/csrf";
import { SECURITY_HEADERS } from "@/lib/security-headers";

// Middleware (Edge runtime): ochrona CSRF dla mutacji /api, odświeżenie sesji Supabase w cookies,
// odesłanie niezalogowanych. To tylko "optymistyczna" kontrola — właściwa autoryzacja (rola,
// aktywność konta) odbywa się zawsze w layoutach/stronach (requirePageRole) i route handlerach
// (requireApiRole), które dodatkowo powtarzają kontrolę CSRF.
//
// Celowo `middleware.ts`, a nie `proxy.ts` z Next 16: proxy działa wyłącznie w runtime Node.js,
// którego obsługa w @opennextjs/cloudflare jest eksperymentalna i powiększa Workera o ~400 KiB gzip.
// Szczegóły: docs/decisions/006-auth-roles.md.

const PUBLIC_PATHS = ["/login"];

/**
 * Nagłówki bezpieczeństwa na odpowiedziach TWORZONYCH w middleware (błędy, redirecty) — next.config ich nie obejmuje.
 * Odpowiedzi przepuszczane (NextResponse.next) dostają je z next.config.ts; dodanie ich tu dałoby duplikaty.
 */
function secure<T extends Response>(res: T): T {
  for (const { key, value } of SECURITY_HEADERS) res.headers.set(key, value);
  return res;
}

function hasBrokenPercentEncoding(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}

function apiError(status: number, code: string, message: string) {
  return secure(NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } }));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi) {
    const csrf = checkMutationRequest(request);
    if (csrf) return apiError(csrf.status, csrf.code, csrf.message);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers ?? {})) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // Nie wstawiać kodu między utworzeniem klienta a getClaims() — tu następuje odświeżenie sesji.
  const { data } = await supabase.auth.getClaims();
  const isLoggedIn = Boolean(data?.claims?.sub);

  if (isLoggedIn && hasBrokenPercentEncoding(pathname)) {
    // Next.js zwraca 500 (DecodeError) dla niepoprawnego kodowania w parametrze ścieżki, zanim zadziała handler.
    // Dla tras skanera (kod z QR/ręczny wpis) odpowiadamy jak na każdy nieznany kod.
    if (pathname.startsWith("/api/v1/locations/by-code/")) {
      return apiError(404, "UNKNOWN_CODE", "Nieznany kod lokalizacji");
    }
    if (pathname.startsWith("/m/lokalizacje/")) {
      const url = request.nextUrl.clone();
      url.pathname = "/m/lokalizacje/-"; // "-" nie jest poprawnym kodem → ekran „Nieznany kod lokalizacji”
      return NextResponse.rewrite(url, { request });
    }
  }

  if (isLoggedIn || PUBLIC_PATHS.includes(pathname)) {
    return response; // nagłówki bezpieczeństwa doda next.config.ts (bez duplikatów)
  }

  if (isApi) {
    return apiError(401, "UNAUTHENTICATED", "Wymagane zalogowanie");
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return secure(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    // Wszystko poza statycznymi plikami Next i plikami z rozszerzeniem obrazka/tekstu.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|webmanifest)$).*)",
  ],
};
