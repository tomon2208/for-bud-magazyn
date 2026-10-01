"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createUserSchema,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  ROLE_LABELS,
  ROLES,
  type AppRole,
} from "@/lib/validation/auth";
import type { UserDto } from "@/server/users";

const SELECT_CLASS =
  "h-9 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

type ApiResult = { ok: true } | { ok: false; message: string };

async function callApi(url: string, method: "POST" | "PATCH", body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, message: json?.error?.message ?? `Błąd serwera (${res.status})` };
  } catch {
    return { ok: false, message: "Brak połączenia z serwerem" };
  }
}

export function UsersAdmin({ users, currentUserId }: { users: UserDto[]; currentUserId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = useRef(false);

  async function run(id: string, action: () => Promise<ApiResult>, success: string) {
    if (busy.current) return false;
    busy.current = true;
    setBusyId(id);
    setMessage(null);
    try {
      const result = await action();
      if (result.ok) {
        setMessage({ kind: "ok", text: success });
        router.refresh();
        return true;
      }
      setMessage({ kind: "error", text: result.message });
      return false;
    } finally {
      busy.current = false;
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <CreateUserForm
        disabled={busyId !== null}
        onCreate={(input) =>
          run("new", () => callApi("/api/v1/admin/users", "POST", input), `Dodano użytkownika ${input.login}`)
        }
      />

      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={
            message.kind === "error"
              ? "rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              : "rounded-md bg-muted p-3 text-sm"
          }
        >
          {message.text}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Login</TableHead>
              <TableHead>Imię i nazwisko</TableHead>
              <TableHead>Rola</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Nowe hasło</TableHead>
              <TableHead className="text-right">Akcje</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                isSelf={u.id === currentUserId}
                busy={busyId !== null}
                onPatch={(patch, success) =>
                  run(u.id, () => callApi(`/api/v1/admin/users/${u.id}`, "PATCH", patch), success)
                }
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CreateUserForm({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (input: { login: string; full_name: string; role: AppRole; password: string }) => Promise<boolean>;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const parsed = createUserSchema.safeParse({
      login: form.get("login"),
      full_name: form.get("full_name"),
      role: form.get("role"),
      password: form.get("password"),
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_");
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    if (await onCreate(parsed.data)) formEl.reset();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dodaj użytkownika</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="new-login" label="Login" error={errors.login}>
            <Input id="new-login" name="login" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field id="new-full-name" label="Imię i nazwisko" error={errors.full_name}>
            <Input id="new-full-name" name="full_name" autoComplete="off" />
          </Field>
          <Field id="new-role" label="Rola" error={errors.role}>
            <select id="new-role" name="role" defaultValue="PRODUKCJA" className={`${SELECT_CLASS} w-full`}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="new-password" label={`Hasło (min. ${PASSWORD_MIN_LENGTH} znaków)`} error={errors.password}>
            <Input id="new-password" name="password" type="password" autoComplete="new-password" />
          </Field>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={disabled}>
              Dodaj użytkownika
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  busy,
  onPatch,
}: {
  user: UserDto;
  isSelf: boolean;
  busy: boolean;
  onPatch: (patch: Record<string, unknown>, success: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AppRole>(user.role);

  async function saveRole() {
    const label = ROLE_LABELS[role];
    if (!window.confirm(`Zmienić rolę użytkownika ${user.login} (${user.fullName}) na: ${label}?`)) {
      setRole(user.role);
      return;
    }
    if (!(await onPatch({ role }, `Zmieniono rolę ${user.login} na ${label}`))) setRole(user.role);
  }

  function toggleActive() {
    if (
      user.active &&
      !window.confirm(
        `Dezaktywować konto ${user.login} (${user.fullName})? Użytkownik zostanie natychmiast wylogowany.`,
      )
    ) {
      return;
    }
    void onPatch({ active: !user.active }, user.active ? `Dezaktywowano ${user.login}` : `Aktywowano ${user.login}`);
  }
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function savePassword() {
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setPasswordError(parsed.error.issues[0]?.message ?? "Nieprawidłowe hasło");
      return;
    }
    setPasswordError(null);
    if (await onPatch({ password: parsed.data }, `Ustawiono nowe hasło dla ${user.login}`)) {
      setPassword("");
    }
  }

  return (
    <TableRow>
      <TableCell className="font-mono">{user.login}</TableCell>
      <TableCell>
        {user.fullName}
        {isSelf && <span className="ml-1 text-xs text-muted-foreground">(Ty)</span>}
      </TableCell>
      <TableCell>
        <div className="flex gap-2">
          <select
            aria-label={`Rola użytkownika ${user.login}`}
            value={role}
            disabled={busy || isSelf}
            onChange={(e) => setRole(e.target.value as AppRole)}
            className={SELECT_CLASS}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          {role !== user.role && (
            <Button type="button" size="lg" disabled={busy} onClick={saveRole}>
              Zapisz
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell>
        {user.active ? <Badge variant="secondary">aktywny</Badge> : <Badge variant="destructive">nieaktywny</Badge>}
      </TableCell>
      <TableCell>
        <div className="flex min-w-56 gap-2">
          <Input
            type="password"
            aria-label={`Nowe hasło dla ${user.login}`}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-9"
          />
          <Button type="button" variant="outline" size="lg" disabled={busy || password.length === 0} onClick={savePassword}>
            Ustaw
          </Button>
        </div>
        {passwordError && <p className="mt-1 text-xs text-destructive">{passwordError}</p>}
      </TableCell>
      <TableCell className="text-right">
        {!isSelf && (
          <Button
            type="button"
            variant={user.active ? "destructive" : "outline"}
            size="lg"
            disabled={busy}
            onClick={toggleActive}
          >
            {user.active ? "Dezaktywuj" : "Aktywuj"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
