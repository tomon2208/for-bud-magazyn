"use client";

import { useRouter } from "next/navigation";
import { CodeScanner } from "../code-scanner";
import { locationHref } from "../lokalizacje/href";

/** Ekran SKANUJ: odczytany kod → ekran lokalizacji. */
export function Scanner() {
  const router = useRouter();
  return <CodeScanner onCode={(code) => router.push(locationHref(code))} />;
}
