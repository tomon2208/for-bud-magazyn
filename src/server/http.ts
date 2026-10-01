import { NextResponse } from "next/server";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    /** Dodatkowe dane błędu domenowego, np. { available: 7 } przy INSUFFICIENT_STOCK. */
    details?: Record<string, unknown>;
  };
};

export function jsonError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string[]>,
  details?: Record<string, unknown>,
) {
  const body: ApiErrorBody = { error: { code, message, ...(fields ? { fields } : {}), ...(details ? { details } : {}) } };
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
