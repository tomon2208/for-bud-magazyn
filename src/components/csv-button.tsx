"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * „Pobierz CSV”: fetch + blob, żeby błąd (401 po wygaśnięciu sesji, 403, 400 „zawęź filtry”, 500) pokazać
 * w UI zamiast zapisywać plik JSON. Nazwa pliku z Content-Disposition.
 */
export function CsvButton({
  url,
  label,
  onError,
  fallbackName = "eksport.csv",
}: {
  url: string;
  label: string;
  onError: (message: string | null) => void;
  fallbackName?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        let message =
          res.status === 401
            ? "Sesja wygasła — zaloguj się ponownie."
            : res.status === 403
              ? "Brak uprawnień do eksportu."
              : "Nie udało się pobrać pliku. Spróbuj ponownie.";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (res.status === 400 && body.error?.message) message = body.error.message;
        } catch {
          // nieczytelne ciało błędu — zostaje komunikat domyślny
        }
        onError(message);
        return;
      }
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = match?.[1] ?? fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      onError("Brak połączenia. Spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" disabled={busy} onClick={() => void download()}>
      {busy ? "Pobieranie…" : label}
    </Button>
  );
}
