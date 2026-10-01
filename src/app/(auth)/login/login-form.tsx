"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loginFormSchema, loginToEmail, type AppRole } from "@/lib/validation/auth";
import { homePathForRole } from "@/lib/authorize";

const GENERIC_ERROR = "Nieprawidłowy login lub hasło";
const INACTIVE_ERROR = "Konto jest nieaktywne. Skontaktuj się z administratorem.";

// Logowanie odbywa się bezpośrednio z przeglądarki do Supabase Auth (limity prób liczone
// per urządzenie, a nie per wspólny adres IP Workera). Serwer i tak weryfikuje rolę
// i aktywność konta przy każdym żądaniu (requirePageRole / requireApiRole).
export function LoginForm({ inactive }: { inactive: boolean }) {
  const [error, setError] = useState<string | null>(inactive ? INACTIVE_ERROR : null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  // Przekierowanie z powodu nieaktywnego konta — usuń pozostałą sesję.
  useEffect(() => {
    if (inactive) {
      void createSupabaseBrowserClient().auth.signOut({ scope: "local" });
    }
  }, [inactive]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return; // blokada podwójnego wysłania
    const form = new FormData(event.currentTarget);
    const parsed = loginFormSchema.safeParse({
      login: form.get("login"),
      password: form.get("password"),
    });
    if (!parsed.success) {
      setError(GENERIC_ERROR);
      return;
    }

    submitting.current = true;
    setPending(true);
    setError(null);
    let keepPending = false;
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: loginToEmail(parsed.data.login),
        password: parsed.data.password,
      });
      if (signInError || !data.user) {
        if (signInError?.code === "user_banned") setError(INACTIVE_ERROR);
        else if (signInError?.code === "over_request_rate_limit" || signInError?.status === 429)
          setError("Zbyt wiele prób logowania. Spróbuj ponownie za chwilę.");
        else setError(GENERIC_ERROR);
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role, active")
        .eq("id", data.user.id)
        .maybeSingle();
      if (profileError) {
        await supabase.auth.signOut({ scope: "local" });
        setError("Nie udało się zalogować. Spróbuj ponownie.");
        return;
      }
      if (!profile || !profile.active) {
        await supabase.auth.signOut({ scope: "local" });
        setError(INACTIVE_ERROR);
        return;
      }

      keepPending = true;
      // Pełne przeładowanie — serwer odczyta świeże cookies sesji.
      window.location.assign(homePathForRole(profile.role as AppRole));
    } catch {
      setError("Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.");
    } finally {
      if (!keepPending) {
        submitting.current = false;
        setPending(false);
      }
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-5 rounded-xl border bg-background p-6 shadow-sm"
      noValidate
    >
      <div className="space-y-2">
        <Label htmlFor="login" className="text-base">
          Login
        </Label>
        <Input
          id="login"
          name="login"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className="h-12 text-lg md:text-lg"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password" className="text-base">
          Hasło
        </Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-12 text-lg md:text-lg"
        />
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="h-12 w-full text-lg">
        {pending ? "Logowanie…" : "Zaloguj"}
      </Button>
    </form>
  );
}
