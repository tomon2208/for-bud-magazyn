"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BackLink } from "./back-link";
import type { SubmitError } from "./use-operation-submit";

// Wspólne elementy kreatorów terminala (PRZYJĘCIE, WYDANIE, PRZESUNIĘCIE): duże cele dotyku (≥ 48 px),
// nagłówek z krokiem, wiersz kontekstu, pole ilości, komunikat błędu wysyłki, ekran dokończenia.

export const BIG_PRIMARY = "h-16 w-full rounded-2xl text-2xl font-bold";
export const BIG_SECONDARY = "h-14 w-full rounded-2xl text-lg font-semibold";
export const BIG_ROW =
  "flex min-h-16 w-full flex-col items-start justify-center gap-0.5 rounded-xl border bg-background px-4 py-2 text-left active:bg-muted";

export function WizardHeader({
  title,
  step,
  total,
  locked,
}: {
  title: string;
  step: number;
  total: number;
  /** W trakcie wysyłania / po wyniku nieznanym nie pokazujemy powrotu (najpierw dokończ albo porzuć). */
  locked: boolean;
}) {
  return (
    <header className="flex items-center justify-between">
      {locked ? (
        <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">Dokończ operację</span>
      ) : (
        <BackLink />
      )}
      <h1 className="pr-3 text-xl font-bold">
        {title}{" "}
        <span className="text-base font-medium text-muted-foreground">
          · {step}/{total}
        </span>
      </h1>
    </header>
  );
}

export function ContextRow({
  label,
  value,
  sub,
  onChange,
  mono = true,
}: {
  label: string;
  value: string;
  sub?: string | null;
  onChange?: () => void;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border bg-background px-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`${mono ? "font-mono" : ""} text-xl font-bold break-all`}>{value}</div>
        {sub && <div className="truncate text-sm text-muted-foreground">{sub}</div>}
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="h-12 shrink-0 rounded-xl px-3 text-base font-medium underline underline-offset-4 active:bg-muted"
        >
          Zmień
        </button>
      )}
    </div>
  );
}

/** Duże pole ilości z jednostką. Przecinek dziesiętny; klawiatura numeryczna dla jednostek całkowitych. */
export function QuantityInput({
  value,
  onChange,
  unit,
  allowsFraction,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  allowsFraction: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Input
          id="qty"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={allowsFraction ? "decimal" : "numeric"}
          autoComplete="off"
          autoFocus
          enterKeyHint="next"
          placeholder={allowsFraction ? "np. 2,5" : "np. 12"}
          aria-invalid={!!error}
          aria-describedby={error ? "qty-error" : undefined}
          className="h-20 min-w-0 flex-1 rounded-2xl px-4 text-right font-mono text-4xl font-bold"
        />
        <span className="shrink-0 text-2xl font-semibold">{unit}</span>
      </div>
      {!allowsFraction && <p className="text-muted-foreground">Tylko liczby całkowite (bez ułamków).</p>}
      {error && (
        <p id="qty-error" role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** Komunikat błędu wysyłki: wynik nieznany (żółty — ponów), sesja wygasła, błąd domenowy (czerwony). */
export function SubmitErrorAlert({ error, menuLabel }: { error: SubmitError; menuLabel: string }) {
  return (
    <div
      role="alert"
      className={
        error.kind === "domain"
          ? "rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive"
          : "rounded-xl bg-amber-100 p-4 text-base font-medium text-amber-900"
      }
    >
      <p>{error.message}</p>
      {error.kind === "network" && (
        <p className="mt-1 font-normal">
          Naciśnij „Spróbuj ponownie” — jeśli operacja już się zapisała, nie zostanie zdublowana.
        </p>
      )}
      {error.kind === "auth" && (
        <p className="mt-1 font-normal">
          <Link href="/login" className="underline underline-offset-4">
            Zaloguj się
          </Link>{" "}
          — po zalogowaniu wejdź w {menuLabel}, a system zaproponuje dokończenie tej operacji.
        </p>
      )}
    </div>
  );
}

/** Ekran „Poprzednia operacja nie została potwierdzona” — Ponów (ten sam id) / Porzuć. */
export function ResumeScreen({
  title,
  what,
  children,
  onResume,
  onDiscard,
}: {
  title: string;
  what: string;
  children: ReactNode;
  onResume: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <span className="inline-flex h-12 items-center px-3 text-lg text-muted-foreground">{title}</span>
      </header>
      <div role="alert" className="rounded-2xl bg-amber-100 p-5 text-amber-950">
        <p className="text-xl font-bold">Poprzednie {what} nie zostało potwierdzone</p>
        <p className="mt-1 text-base">
          Nie wiadomo, czy zapisało się w systemie. Ponów — jeśli już zostało zapisane, nie zostanie zdublowane.
        </p>
      </div>
      <section className="rounded-2xl border bg-background p-5 text-center">{children}</section>
      <Button type="button" className={BIG_PRIMARY} onClick={onResume}>
        Ponów (bez ryzyka duplikatu)
      </Button>
      <Button type="button" variant="outline" className={BIG_SECONDARY} onClick={onDiscard}>
        Porzuć
      </Button>
    </div>
  );
}

/** Przycisk „Zakończ” (powrót do menu terminala). */
export function FinishLink() {
  return (
    <Link
      href="/m"
      className="flex h-14 w-full items-center justify-center rounded-2xl border bg-background text-lg font-semibold active:bg-muted"
    >
      Zakończ
    </Link>
  );
}
