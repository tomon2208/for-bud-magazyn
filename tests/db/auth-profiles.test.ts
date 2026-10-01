import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, updateUser } from "@/server/users";
import {
  adminClient,
  anonClient,
  createTestUser,
  deleteAllTestUsers,
  findAuthUserByEmail,
  signIn,
  testLogin,
  testPassword,
  type TestUser,
} from "./helpers";

// Testy integracyjne na bazie dev. Tworzą konta z prefiksem "test-" i usuwają je po sobie.
// Prawdziwego konta "admin" NIE modyfikujemy (wyjątek: siatka bezpieczeństwa przywracająca je,
// gdyby ochrona ostatniego admina zawiodła).

const admin = adminClient();
let tAdmin: TestUser;
let tBiuro: TestUser;
let tProdukcja: TestUser;
let adminSession: SupabaseClient;
let biuroSession: SupabaseClient;
let produkcjaSession: SupabaseClient;

beforeAll(async () => {
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProdukcja = await createTestUser(admin, "PRODUKCJA");
  [adminSession, biuroSession, produkcjaSession] = await Promise.all([
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProdukcja),
  ]);
});

afterAll(async () => {
  await deleteAllTestUsers(admin);
});

describe("tworzenie konta → profil (trigger)", () => {
  it("tworzy profil z app_metadata", async () => {
    const { data, error } = await admin.from("profiles").select("*").eq("id", tBiuro.id).single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ login: tBiuro.login, role: "BIURO", active: true, full_name: "Test BIURO" });
  });

  it.each([
    ["bez roli", (login: string) => ({ login, full_name: "X" })],
    ["ze złą rolą", (login: string) => ({ login, full_name: "X", role: "SZEF" })],
    ["bez loginu", () => ({ full_name: "X", role: "BIURO" })],
    ["bez imienia i nazwiska", (login: string) => ({ login, role: "BIURO" })],
    ["z loginem niezgodnym z e-mailem", () => ({ login: "test-inny", full_name: "X", role: "BIURO" })],
    ["z loginem wielkimi literami", (login: string) => ({ login: login.toUpperCase(), full_name: "X", role: "BIURO" })],
  ])("createUser %s nie tworzy konta", async (_name, meta) => {
    const login = testLogin("bad");
    const email = `${login}@forbud.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: testPassword(),
      email_confirm: true,
      app_metadata: meta(login),
    });
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
    expect(await findAuthUserByEmail(admin, email)).toBeNull();
    const { data: profiles } = await admin.from("profiles").select("id").eq("login", login);
    expect(profiles).toEqual([]);
  });
});

describe("RLS profiles — odczyt", () => {
  it("anon nie czyta profiles", async () => {
    const { data, error } = await anonClient().from("profiles").select("id");
    // Brak GRANT dla anon → błąd uprawnień (42501); w żadnym wypadku nie zwraca danych.
    expect(data ?? []).toEqual([]);
    expect(error?.code).toBe("42501");
  });

  it.each([
    ["PRODUKCJA", () => produkcjaSession, () => tProdukcja],
    ["BIURO", () => biuroSession, () => tBiuro],
  ])("%s widzi tylko swój profil", async (_role, session, user) => {
    const { data, error } = await session().from("profiles").select("id, login, role");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: user().id, login: user().login, role: user().role }]);
  });

  it("ADMIN widzi wszystkie profile", async () => {
    const { data, error } = await adminSession.from("profiles").select("id, login");
    expect(error).toBeNull();
    const logins = (data ?? []).map((r) => r.login);
    expect(logins).toEqual(expect.arrayContaining([tAdmin.login, tBiuro.login, tProdukcja.login, "admin"]));
  });
});

describe("RLS profiles — zapis zablokowany dla authenticated", () => {
  it("nie może zmienić własnej roli (UPDATE)", async () => {
    const { error } = await produkcjaSession.from("profiles").update({ role: "ADMIN" }).eq("id", tProdukcja.id);
    expect(error?.code).toBe("42501");
    const { data } = await admin.from("profiles").select("role").eq("id", tProdukcja.id).single();
    expect(data?.role).toBe("PRODUKCJA");
  });

  it("ADMIN też nie zmienia profili bezpośrednio (tylko serwer kluczem secret)", async () => {
    const { error } = await adminSession.from("profiles").update({ active: false }).eq("id", tBiuro.id);
    expect(error?.code).toBe("42501");
  });

  it("nie może INSERT ani DELETE", async () => {
    const ins = await biuroSession
      .from("profiles")
      .insert({ id: crypto.randomUUID(), login: "test-hack", full_name: "X", role: "ADMIN" });
    expect(ins.error?.code).toBe("42501");
    const del = await biuroSession.from("profiles").delete().eq("id", tBiuro.id);
    expect(del.error?.code).toBe("42501");
    const { data } = await admin.from("profiles").select("id").eq("id", tBiuro.id);
    expect(data).toHaveLength(1);
  });

  it("anon nie może INSERT", async () => {
    const { error } = await anonClient()
      .from("profiles")
      .insert({ id: crypto.randomUUID(), login: "test-anon", full_name: "X", role: "ADMIN" });
    expect(error?.code).toBe("42501");
  });

  it("login jest niezmienny (nawet dla klucza secret)", async () => {
    const { error } = await admin.from("profiles").update({ login: "test-zmieniony" }).eq("id", tBiuro.id);
    expect(error?.code).toBe("23514"); // check_violation z triggera profiles_before_update
    expect(error?.message).toBe("Nie można zmienić loginu");
    const { data } = await admin.from("profiles").select("login").eq("id", tBiuro.id).single();
    expect(data?.login).toBe(tBiuro.login);
  });
});

describe("nieaktywny użytkownik", () => {
  it("dezaktywowany ADMIN traci uprawnienia natychmiast (app.user_role() = NULL)", async () => {
    const extra = await createTestUser(admin, "ADMIN", "admin2");
    const session = await signIn(extra);

    const before = await session.from("profiles").select("id");
    expect((before.data ?? []).length).toBeGreaterThan(1);

    const { error } = await admin.from("profiles").update({ active: false }).eq("id", extra.id);
    expect(error).toBeNull();

    // Ten sam token JWT — polityka ADMIN już nie działa, widać tylko własny wiersz.
    const after = await session.from("profiles").select("id, active");
    expect(after.error).toBeNull();
    expect(after.data).toEqual([{ id: extra.id, active: false }]);
  });
});

describe("serwis użytkowników (src/server/users.ts)", () => {
  it("duplikat loginu → 409 LOGIN_TAKEN", async () => {
    const r = await createUser({ login: tBiuro.login, full_name: "X", role: "BIURO", password: testPassword() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ status: 409, code: "LOGIN_TAKEN" });
  });

  it("tworzy użytkownika i zwraca profil", async () => {
    const login = testLogin("svc");
    const r = await createUser({ login, full_name: "Jan Test", role: "PRODUKCJA", password: testPassword() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toMatchObject({ login, fullName: "Jan Test", role: "PRODUKCJA", active: true });
  });

  it("admin nie może zdezaktywować ani zdegradować siebie", async () => {
    const a = await updateUser(tAdmin.id, tAdmin.id, { active: false });
    const b = await updateUser(tAdmin.id, tAdmin.id, { role: "BIURO" });
    expect(!a.ok && a.error.code).toBe("SELF_LOCKOUT");
    expect(!b.ok && b.error.code).toBe("SELF_LOCKOUT");
  });

  it("nieistniejący użytkownik → 404", async () => {
    const r = await updateUser(tAdmin.id, crypto.randomUUID(), { full_name: "X" });
    expect(!r.ok && r.error.status).toBe(404);
  });

  it("dezaktywacja blokuje logowanie (ban), aktywacja przywraca; zmiana hasła działa", async () => {
    const u = await createTestUser(admin, "PRODUKCJA", "ban");

    const off = await updateUser(tAdmin.id, u.id, { active: false });
    expect(off.ok && off.data.active).toBe(false);
    const login1 = await anonClient().auth.signInWithPassword({
      email: `${u.login}@forbud.local`,
      password: u.password,
    });
    expect(login1.error).not.toBeNull();

    const newPassword = testPassword();
    const on = await updateUser(tAdmin.id, u.id, { active: true, password: newPassword, role: "BIURO" });
    expect(on.ok && on.data).toMatchObject({ active: true, role: "BIURO" });

    const oldPw = await anonClient().auth.signInWithPassword({
      email: `${u.login}@forbud.local`,
      password: u.password,
    });
    expect(oldPw.error).not.toBeNull();
    await expect(signIn({ login: u.login, password: newPassword })).resolves.toBeDefined();
  });
});

describe("unieważnianie sesji przy dezaktywacji", () => {
  it("po dezaktywacji i ponownej aktywacji stary refresh token nie działa", async () => {
    const u = await createTestUser(admin, "PRODUKCJA", "sess");
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: `${u.login}@forbud.local`,
      password: u.password,
    });
    expect(error).toBeNull();

    // Kontrola: przed dezaktywacją refresh token działa (i rotuje się).
    const refreshed = await anonClient().auth.refreshSession({ refresh_token: data.session!.refresh_token });
    expect(refreshed.error).toBeNull();
    const token = refreshed.data.session!.refresh_token;

    expect((await updateUser(tAdmin.id, u.id, { active: false })).ok).toBe(true);
    expect((await updateUser(tAdmin.id, u.id, { active: true })).ok).toBe(true);

    const after = await anonClient().auth.refreshSession({ refresh_token: token });
    expect(after.error).not.toBeNull();
    expect(after.data.session).toBeNull();
  });

  it("authenticated nie może wywołać revoke_user_sessions", async () => {
    const { error } = await biuroSession.rpc("revoke_user_sessions", { p_user_id: tProdukcja.id });
    expect(error).not.toBeNull();
    // Sesja PRODUKCJA nadal działa.
    const { error: readError } = await produkcjaSession.from("profiles").select("id");
    expect(readError).toBeNull();
  });
});
