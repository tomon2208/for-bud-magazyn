import { Label } from "@/components/ui/label";
import type { Notice } from "@/lib/api-client";

export const SELECT_CLASS =
  "h-9 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

export function Field({
  id,
  label,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function NoticeBox({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p
      role={notice.kind === "error" ? "alert" : "status"}
      className={
        notice.kind === "error"
          ? "rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          : "rounded-md bg-muted p-3 text-sm"
      }
    >
      {notice.text}
    </p>
  );
}

/**
 * Desktopowy komunikat o niepotwierdzonej operacji magazynowej (wynik nieznany albo wygasła sesja):
 * dane zablokowane, jedyne akcje — ponowienie tym samym id albo porzucenie i sprawdzenie listy.
 */
export function UnresolvedAttemptAlert({
  status,
  what,
  listName,
  saved = "zostało zapisane",
}: {
  status: string;
  what: string;
  listName: string;
  /** Odmiana: „zostało zapisane” (wydanie) / „została zapisana” (korekta). */
  saved?: string;
}) {
  return (
    <div role="alert" className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">
      <p className="font-semibold">
        {status === "auth"
          ? "Sesja wygasła — zaloguj się w nowej karcie, potem ponów (ten sam identyfikator, bez duplikatu)."
          : `Nie wiadomo, czy ${what} ${saved} (brak odpowiedzi serwera).`}
      </p>
      <p>
        Dane są zablokowane. Ponów to samo żądanie — jeśli zostało już zapisane, nie zostanie zdublowane — albo porzuć je i
        sprawdź wynik na liście {listName}.
      </p>
    </div>
  );
}
