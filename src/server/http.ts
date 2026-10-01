import { NextResponse } from "next/server";

export type ApiErrorBody = { error: { code: string; message: string; fields?: Record<string, string[]> } };

export function jsonError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string[]>,
) {
  const body: ApiErrorBody = { error: { code, message, ...(fields ? { fields } : {}) } };
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
