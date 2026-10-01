import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const TEST_PREFIX = "test-";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Brak zmiennej ${name} w .env.local`);
  return v;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function adminClient(): SupabaseClient {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), noSession);
}

export function anonClient(): SupabaseClient {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), noSession);
}

export type TestUser = { id: string; login: string; password: string; role: string };

export function testLogin(tag: string): string {
  return `${TEST_PREFIX}${tag}-${randomBytes(3).toString("hex")}`;
}

export function testPassword(): string {
  return `T-${randomBytes(12).toString("base64url")}`;
}

export async function createTestUser(admin: SupabaseClient, role: string, tag = role.toLowerCase()): Promise<TestUser> {
  const login = testLogin(tag);
  const password = testPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${login}@forbud.local`,
    password,
    email_confirm: true,
    app_metadata: { login, full_name: `Test ${role}`, role },
  });
  if (error || !data.user) throw new Error(`Nie udało się utworzyć ${login}: ${error?.message}`);
  return { id: data.user.id, login, password, role };
}

export async function signIn(user: Pick<TestUser, "login" | "password">): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: `${user.login}@forbud.local`,
    password: user.password,
  });
  if (error) throw new Error(`Logowanie ${user.login} nieudane: ${error.code ?? error.message}`);
  return client;
}

/** Usuwa wszystkie konta testowe (login z prefiksem test-), także pozostałe po przerwanych uruchomieniach. */
export async function deleteAllTestUsers(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.from("profiles").select("id, login").like("login", `${TEST_PREFIX}%`);
  if (error) throw new Error(`Odczyt kont testowych: ${error.message}`);
  for (const row of data ?? []) {
    if (!row.login.startsWith(TEST_PREFIX)) continue;
    const { error: delError } = await admin.auth.admin.deleteUser(row.id);
    if (delError) console.warn(`Nie usunięto ${row.login}: ${delError.message}`);
  }
}

export async function findAuthUserByEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email === email);
    if (found) return found;
    if (data.users.length < 200) return null;
  }
  return null;
}
