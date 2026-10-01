import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder, listOrders, updateOrder } from "@/server/orders";
import { adminClient, anonClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Zlecenia produkcyjne (Etap 5, ADR 010): RLS i role (zapis BIURO/ADMIN, odczyt wszyscy aktywni), brak DELETE,
// audyt niepodrabialny, normalizacja. Dane: nazwy z prefiksem TEST-<runId>-, sprzątane kluczem secret.

const admin = adminClient();
const anon = anonClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let tInactive: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;
let asInactive: SupabaseClient;

beforeAll(async () => {
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  tInactive = await createTestUser(admin, "BIURO", "nieaktywny");
  [asAdmin, asBiuro, asProd, asInactive] = await Promise.all([signIn(tAdmin), signIn(tBiuro), signIn(tProd), signIn(tInactive)]);
  const off = await admin.from("profiles").update({ active: false }).eq("id", tInactive.id);
  if (off.error) throw off.error;
});

afterAll(async () => {
  try {
    await admin.from("production_orders").delete().like("name", `${P}-%`);
  } finally {
    await deleteAllTestUsers(admin);
  }
});

describe("production_orders — role i RLS", () => {
  it("BIURO i ADMIN tworzą; nazwa przycięta, pusta notatka → NULL, status OPEN, audyt z auth.uid()", async () => {
    for (const [session, user] of [
      [asBiuro, tBiuro],
      [asAdmin, tAdmin],
    ] as const) {
      const res = await session
        .from("production_orders")
        .insert({ name: `  ${P}-Kowalski `, notes: "   " })
        .select("*")
        .single();
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({
        name: `${P}-Kowalski`,
        notes: null,
        status: "OPEN",
        created_by: user.id,
        updated_by: user.id,
      });
    }
  });

  it("nazwa NIEunikalna: dwa zlecenia o tej samej nazwie", async () => {
    const { count } = await admin
      .from("production_orders")
      .select("id", { count: "exact", head: true })
      .eq("name", `${P}-Kowalski`);
    expect(count).toBe(2);
  });

  it("audyt niepodrabialny: created_by/created_at z żądania ignorowane, przy UPDATE updated_by = edytujący", async () => {
    const ins = await asBiuro
      .from("production_orders")
      .insert({ name: `${P}-Audyt`, created_by: tAdmin.id, created_at: "2000-01-01T00:00:00Z", updated_by: tAdmin.id })
      .select("*")
      .single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ created_by: tBiuro.id, updated_by: tBiuro.id });
    expect(ins.data!.created_at.startsWith("2000")).toBe(false);

    const upd = await asAdmin
      .from("production_orders")
      .update({ status: "DONE", created_by: tProd.id })
      .eq("id", ins.data!.id)
      .select("*")
      .single();
    expect(upd.error).toBeNull();
    expect(upd.data).toMatchObject({ status: "DONE", created_by: tBiuro.id, updated_by: tAdmin.id });
  });

  it("PRODUKCJA nie tworzy (42501) ani nie zmienia zleceń (RLS: 0 wierszy), ale je czyta", async () => {
    const ins = await asProd.from("production_orders").insert({ name: `${P}-Prod` });
    expect(ins.error?.code).toBe("42501");
    const { data: one } = await admin.from("production_orders").select("id").like("name", `${P}-%`).limit(1).single();
    // UPDATE: polityka RLS (USING) odfiltrowuje wiersze — PostgREST zwraca 0 zmienionych wierszy; status bez zmian.
    const upd = await asProd.from("production_orders").update({ status: "CANCELLED" }).eq("id", one!.id).select("id");
    expect(upd.error === null ? upd.data : upd.error.code).toEqual([]);
    const after = await admin.from("production_orders").select("status").eq("id", one!.id).single();
    expect(after.data?.status).not.toBe("CANCELLED");
    const read = await asProd.from("production_orders").select("id, name").like("name", `${P}-%`);
    expect(read.error).toBeNull();
    expect(read.data!.length).toBeGreaterThanOrEqual(3);
  });

  it("brak DELETE dla wszystkich ról aplikacyjnych", async () => {
    for (const session of [asAdmin, asBiuro, asProd]) {
      const del = await session.from("production_orders").delete().like("name", `${P}-%`);
      expect(del.error?.code).toBe("42501");
    }
    const { count } = await admin.from("production_orders").select("id", { count: "exact", head: true }).like("name", `${P}-%`);
    expect(count).toBe(3);
  });

  it("anon nie czyta; nieaktywny nie widzi nic i nie zapisze", async () => {
    expect((await anon.from("production_orders").select("id").limit(1)).error?.code).toBe("42501");
    const r = await asInactive.from("production_orders").select("id").like("name", `${P}-%`);
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(0);
    const ins = await asInactive.from("production_orders").insert({ name: `${P}-Off` });
    expect(ins.error?.code).toBe("42501");
  });

  it("walidacja w bazie: pusta nazwa / > 120 / zły status / notatka > 500 → 23514", async () => {
    const rows: Record<string, unknown>[] = [
      { name: "   " },
      { name: "x".repeat(121) },
      { name: `${P}-S`, status: "IN_PROGRESS" },
      { name: `${P}-N`, notes: "x".repeat(501) },
    ];
    for (const row of rows) {
      const res = await asBiuro.from("production_orders").insert(row);
      expect(res.error?.code, JSON.stringify(row).slice(0, 40)).toBe("23514");
    }
  });
});

describe("serwis zleceń", () => {
  it("createOrder / updateOrder / listOrders (status, fraza, najnowsze pierwsze)", async () => {
    const a = await createOrder(asBiuro, { name: `${P}-Nowak`, notes: "okna PCV" });
    expect(a.ok).toBe(true);
    const b = await createOrder(asBiuro, { name: `${P}-Nowak` });
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const done = await updateOrder(asBiuro, a.data.id, { status: "DONE" });
    expect(done.ok && done.data.status).toBe("DONE");

    const open = await listOrders(asProd, { status: "OPEN", q: `${P}-Nowak`, page: 1, pageSize: 50 });
    expect(open.ok && open.data.items.map((o) => o.id)).toEqual([b.data.id]);
    const all = await listOrders(asProd, { q: `${P}-Nowak`, page: 1, pageSize: 50 });
    expect(all.ok && all.data.items.map((o) => o.id)).toEqual([b.data.id, a.data.id]); // najnowsze pierwsze
    // Fraza dosłowna: % nie działa jak wildcard.
    const pct = await listOrders(asProd, { q: `${P}-%`, page: 1, pageSize: 50 });
    expect(pct.ok && pct.data.total).toBe(0);

    const forbidden = await createOrder(asProd, { name: `${P}-X` });
    expect(forbidden.ok ? null : forbidden.error).toMatchObject({ status: 403 });
    const missing = await updateOrder(asBiuro, "00000000-0000-4000-8000-000000000000", { name: "x" });
    expect(missing.ok ? null : missing.error).toMatchObject({ status: 404 });
  });
});
