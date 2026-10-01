import "server-only";
import type { ZodType } from "zod";
import type { NextResponse } from "next/server";
import { checkMutationRequest } from "@/lib/csrf";
import { jsonError } from "./http";

/**
 * Kontrola CSRF dla metod mutujących (Content-Type JSON + ten sam Origin).
 * Wywoływana w każdym route handlerze POST/PUT/PATCH/DELETE (przez parseJsonBody albo bezpośrednio)
 * — niezależnie od middleware, które robi to samo.
 */
export function guardMutation(request: Request): NextResponse | null {
  const failure = checkMutationRequest(request);
  return failure ? jsonError(failure.status, failure.code, failure.message) : null;
}

/** Kontrola CSRF + odczyt i walidacja JSON z żądania. Zwraca dane albo gotową odpowiedź błędu. */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  const csrf = guardMutation(request);
  if (csrf) return { ok: false, response: csrf };

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_JSON", "Nieprawidłowe dane żądania") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join(".") : "_";
      (fields[key] ??= []).push(issue.message);
    }
    const first = parsed.error.issues[0]?.message ?? "Nieprawidłowe dane";
    return { ok: false, response: jsonError(400, "VALIDATION", first, fields) };
  }
  return { ok: true, data: parsed.data };
}
