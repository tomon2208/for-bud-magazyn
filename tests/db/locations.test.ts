import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocation, createLocationsBulk, getLocationByCode, listLocations } from "@/server/locations";
import { adminClient, anonClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Testy RLS i reguł lokalizacji na bazie dev. Dane testowe mają prefiks TEST-<runId>- (unikalny na przebieg)
// i są sprzątane kluczem secret (authenticated nie ma DELETE) — wyłącznie własny runId.

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`; // 13 znaków; kod lokalizacji ma max 20 (sufiksy ≤ 7)

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProdukcja: TestUser;
let tInactive: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProdukcja: SupabaseClient;
let asInactive: SupabaseClient;
const anon = anonClient();

let locationId: string;

async function cleanupLocations() {
  await admin.from("locations").delete().like("code", `${P}-%`);
}

beforeAll(async () => {
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProdukcja = await createTestUser(admin, "PRODUKCJA");
  tInactive = await createTestUser(admin, "PRODUKCJA", "nieaktywny");
  [asAdmin, asBiuro, asProdukcja, asInactive] = await Promise.all([
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProdukcja),
    signIn(tInactive),
  ]);
  const { error } = await admin.from("profiles").update({ active: false }).eq("id", tInactive.id);
  if (error) throw error;

  const loc = await asAdmin.from("locations").insert({ code: `${P}-L1`, name: "Regał testowy" }).select().single();
  if (loc.error) throw loc.error;
  locationId = loc.data.id;
});

afterAll(async () => {
  await cleanupLocations(); // przed usunięciem kont (FK created_by → profiles)
  await deleteAllTestUsers(admin);
});

describe("RLS — odczyt", () => {
  it("anon nie ma dostępu", async () => {
    const { data, error } = await anon.from("locations").select("id").limit(1);
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it("nieaktywny użytkownik nie widzi nic", async () => {
    const { data, error } = await asInactive.from("locations").select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it.each([
    ["ADMIN", () => asAdmin],
    ["BIURO", () => asBiuro],
    ["PRODUKCJA", () => asProdukcja],
  ])("%s czyta lokalizacje", async (_role, session) => {
    const { data, error } = await session().from("locations").select("id, code").eq("id", locationId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe("RLS — zapis tylko ADMIN", () => {
  it("INSERT przez BIURO/PRODUKCJA/nieaktywnego → 42501 z triggera", async () => {
    for (const session of [asBiuro, asProdukcja, asInactive]) {
      const res = await session.from("locations").insert({ code: `${P}-ZLY` });
      expect(res.error?.code).toBe("42501");
      expect(res.error?.message).toBe("Brak uprawnień do zapisu lokalizacji");
    }
    const { data } = await admin.from("locations").select("id").eq("code", `${P}-ZLY`);
    expect(data).toHaveLength(0);
  });

  it("UPDATE przez BIURO/PRODUKCJA/nieaktywnego niemożliwy", async () => {
    for (const session of [asBiuro, asProdukcja, asInactive]) {
      const res = await session.from("locations").update({ name: "hack" }).eq("id", locationId).select();
      expect(res.error?.code ?? "none").toMatch(/42501|none/);
      expect(res.data ?? []).toHaveLength(0);
    }
    const { data } = await admin.from("locations").select("name").eq("id", locationId).single();
    expect(data?.name).toBe("Regał testowy");
  });

  it("ADMIN edytuje i dezaktywuje", async () => {
    const res = await asAdmin.from("locations").update({ description: "opis", active: false }).eq("id", locationId).select().single();
    expect(res.error).toBeNull();
    expect(res.data?.active).toBe(false);
    const back = await asAdmin.from("locations").update({ active: true }).eq("id", locationId).select();
    expect(back.data).toHaveLength(1);
  });

  it("DELETE niemożliwy dla nikogo (authenticated)", async () => {
    for (const session of [asAdmin, asBiuro, asProdukcja]) {
      const res = await session.from("locations").delete().eq("id", locationId).select();
      expect(res.error?.code).toBe("42501");
    }
    const { data } = await admin.from("locations").select("id").eq("id", locationId);
    expect(data).toHaveLength(1);
  });
});

describe("kod: normalizacja i unikalność", () => {
  it("zapisuje UPPERCASE z przycięciem; format wymuszony przez bazę", async () => {
    const ins = await asAdmin.from("locations").insert({ code: ` ${P.toLowerCase()}-n1 ` }).select().single();
    expect(ins.error).toBeNull();
    expect(ins.data?.code).toBe(`${P}-N1`);
    for (const bad of [`${P}-A B`, `${P}-Ą`, "x".repeat(21), "---", "A/B", "A:B"]) {
      const res = await asAdmin.from("locations").insert({ code: bad });
      expect(res.error?.code, bad).toBe("23514");
    }
  });

  it("unikalność niezależna od wielkości liter", async () => {
    const first = await asAdmin.from("locations").insert({ code: `${P}-U1` });
    expect(first.error).toBeNull();
    const dup = await asAdmin.from("locations").insert({ code: `${P.toLowerCase()}-u1` });
    expect(dup.error?.code).toBe("23505");
  });

  it("zmiana kodu przez ADMIN działa i zachowuje id; kolizja → 23505", async () => {
    const res = await asAdmin.from("locations").update({ code: `${P.toLowerCase()}-l1b` }).eq("id", locationId).select().single();
    expect(res.data?.code).toBe(`${P}-L1B`);
    expect(res.data?.id).toBe(locationId);
    const clash = await asAdmin.from("locations").update({ code: `${P}-U1` }).eq("id", locationId);
    expect(clash.error?.code).toBe("23505");
    await asAdmin.from("locations").update({ code: `${P}-L1` }).eq("id", locationId);
  });

  it("puste name/description → NULL", async () => {
    const res = await asAdmin.from("locations").insert({ code: `${P}-E1`, name: "  ", description: "" }).select().single();
    expect(res.data?.name).toBeNull();
    expect(res.data?.description).toBeNull();
  });
});

describe("audyt (created_by / updated_by)", () => {
  it("klient nie może podrobić created_by/updated_by/created_at/id", async () => {
    const ins = await asAdmin
      .from("locations")
      .insert({ code: `${P}-AU1`, created_by: tBiuro.id, updated_by: tBiuro.id, created_at: "2000-01-01T00:00:00Z" })
      .select()
      .single();
    expect(ins.error).toBeNull();
    expect(ins.data?.created_by).toBe(tAdmin.id);
    expect(ins.data?.updated_by).toBe(tAdmin.id);
    expect(new Date(ins.data!.created_at).getFullYear()).toBeGreaterThan(2000);

    const upd = await asAdmin
      .from("locations")
      .update({ created_by: tBiuro.id, created_at: "2000-01-01T00:00:00Z", updated_by: tBiuro.id, name: "Audyt 2" })
      .eq("id", ins.data!.id)
      .select()
      .single();
    expect(upd.data?.created_by).toBe(tAdmin.id);
    expect(upd.data?.updated_by).toBe(tAdmin.id);
    expect(new Date(upd.data!.created_at).getFullYear()).toBeGreaterThan(2000);

    const id = await asAdmin.from("locations").update({ id: crypto.randomUUID() }).eq("id", ins.data!.id);
    expect(id.error?.code).toBe("23514");
  });
});

describe("serwis: bulk, by-code, lista", () => {
  it("bulk: wszystkie zapisane jednym żądaniem, posortowane", async () => {
    const items = [`${P}-B3`, `${P}-B1`, `${P}-B2`].map((code) => ({ code, name: null }));
    const res = await createLocationsBulk(asAdmin, { items });
    expect(res.ok && res.data.map((l) => l.code)).toEqual([`${P}-B1`, `${P}-B2`, `${P}-B3`]);
  });

  it("bulk transakcyjny: duplikat w środku → nic nie zapisane, 409 z listą kodów", async () => {
    const taken = `${P}-T2`;
    expect((await createLocation(asAdmin, { code: taken })).ok).toBe(true);
    const items = [`${P}-T1`, taken, `${P}-T3`].map((code) => ({ code }));
    const res = await createLocationsBulk(asAdmin, { items });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.code).toBe("CODE_TAKEN");
      expect(res.error.fields?.codes).toEqual([taken]);
      expect(res.error.message).toContain(taken);
    }
    const { data } = await admin.from("locations").select("code").in("code", [`${P}-T1`, `${P}-T3`]);
    expect(data).toHaveLength(0);
  });

  it("bulk przez BIURO → 403", async () => {
    const res = await createLocationsBulk(asBiuro, { items: [{ code: `${P}-BZ1` }] });
    expect(!res.ok && res.error.status).toBe(403);
    const { data } = await admin.from("locations").select("id").eq("code", `${P}-BZ1`);
    expect(data).toHaveLength(0);
  });

  it("równoległe bulki z tym samym kodem: dokładnie jeden wygrywa, drugi nic nie zapisuje", async () => {
    const mk = (extra: string) => [{ code: `${P}-RC` }, { code: `${P}-${extra}` }];
    const [a, b] = await Promise.all([
      createLocationsBulk(asAdmin, { items: mk("RA") }),
      createLocationsBulk(asAdmin, { items: mk("RB") }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const { data } = await admin.from("locations").select("code").like("code", `${P}-R%`);
    expect(data).toHaveLength(2);
  });

  it("by-code: normalizacja, nieaktywna zwracana, nieznany/zły format → 404", async () => {
    const ok = await getLocationByCode(asProdukcja, `  ${P.toLowerCase()}-l1 `);
    expect(ok.ok && ok.data.code).toBe(`${P}-L1`);

    await asAdmin.from("locations").update({ active: false }).eq("code", `${P}-U1`);
    const inactive = await getLocationByCode(asProdukcja, `${P}-U1`);
    expect(inactive.ok && inactive.data.active).toBe(false);

    for (const bad of [`${P}-NIEMA`, "", "A B", "x".repeat(40), "https://x.pl/a"]) {
      const res = await getLocationByCode(asProdukcja, bad);
      expect(!res.ok && res.error.status, bad).toBe(404);
      expect(!res.ok && res.error.message).toBe("Nieznany kod lokalizacji");
    }
  });

  it("lista: wyszukiwanie po kodzie i nazwie, includeInactive, znaki specjalne dosłownie", async () => {
    const q = (extra: object) => listLocations(asBiuro, { q: undefined, page: 1, pageSize: 100, includeInactive: false, ...extra });
    const byCode = await q({ q: `${P}-l1` });
    expect(byCode.ok && byCode.data.items.map((l) => l.code)).toEqual([`${P}-L1`]);
    const byName = await q({ q: "regał testowy" });
    expect(byName.ok && byName.data.items.some((l) => l.code === `${P}-L1`)).toBe(true);

    const hidden = await q({ q: `${P}-U1` });
    expect(hidden.ok && hidden.data.total).toBe(0);
    const shown = await q({ q: `${P}-U1`, includeInactive: true });
    expect(shown.ok && shown.data.total).toBe(1);

    const wildcard = await q({ q: "%" });
    expect(wildcard.ok && wildcard.data.total).toBe(0);

    const outOfRange = await q({ q: P, includeInactive: true, page: 9999 });
    expect(outOfRange.ok && outOfRange.data.items).toEqual([]);
    expect(outOfRange.ok && outOfRange.data.total).toBeGreaterThan(0);
  });
});

describe("kolejność triggerów", () => {
  it("kontrola roli (42501) wyprzedza audyt i normalizację — BIURO nie zapisze nic nawet z poprawnym kodem", async () => {
    const res = await asBiuro.from("locations").insert({ code: `${P}-TRG` });
    expect(res.error?.code).toBe("42501");
    const { data } = await admin.from("locations").select("id").eq("code", `${P}-TRG`);
    expect(data).toHaveLength(0);
  });
});
