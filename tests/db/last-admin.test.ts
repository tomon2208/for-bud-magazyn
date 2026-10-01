import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, deleteAllTestUsers, type TestUser } from "./helpers";

// Ochrona ostatniego aktywnego ADMIN-a testowana bezpośrednio w SQL (SUPABASE_DB_URL z .env.scripts).
// Każdy scenariusz działa w transakcji, która ZAWSZE kończy się ROLLBACK (rzucamy wyjątek na końcu),
// więc prawdziwe konto `admin` nigdy nie jest trwale zmieniane — jego wiersz jest modyfikowany
// wyłącznie wewnątrz niezatwierdzonej transakcji, aby testowy ADMIN stał się "ostatnim".

const dbUrl = process.env.SUPABASE_DB_URL;
const admin = adminClient();
let sql: postgres.Sql;
let tAdmin: TestUser;
let tAdmin2: TestUser;

const NOT_BLOCKED = "NIE_ZABLOKOWANO";

async function inRolledBackTx(
  fn: (tx: postgres.TransactionSql) => Promise<unknown>,
  options = "isolation level read committed",
): Promise<{ hint?: string; message: string }> {
  return sql
    .begin(options, async (tx) => {
      await fn(tx);
      throw new Error(NOT_BLOCKED); // wymusza ROLLBACK także wtedy, gdy ochrona zawiedzie
    })
    .then(
      () => ({ message: "commit (nie powinno wystąpić)" }),
      (e: { hint?: string; message: string }) => e,
    );
}

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN", "last");
  tAdmin2 = await createTestUser(admin, "ADMIN", "last2");
});

afterAll(async () => {
  await sql?.end();
  await deleteAllTestUsers(admin);
});

async function snapshotAdmins() {
  return sql`select id, role, active, updated_at from public.profiles where role = 'ADMIN' order by id`;
}

describe("ochrona ostatniego aktywnego ADMIN-a (SQL, transakcje z ROLLBACK)", () => {
  it("dezaktywacja ostatniego aktywnego ADMIN-a jest blokowana", async () => {
    const before = await snapshotAdmins();
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set active = false where role = 'ADMIN' and active and id <> ${tAdmin.id}`;
      await tx`update public.profiles set active = false where id = ${tAdmin.id}`;
    });
    expect(err.hint).toBe("LAST_ADMIN");
    expect(await snapshotAdmins()).toEqual(before);
  });

  it("degradacja (zmiana roli) ostatniego ADMIN-a jest blokowana", async () => {
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set active = false where role = 'ADMIN' and active and id <> ${tAdmin.id}`;
      await tx`update public.profiles set role = 'BIURO' where id = ${tAdmin.id}`;
    });
    expect(err.hint).toBe("LAST_ADMIN");
  });

  it("usunięcie konta ostatniego ADMIN-a (kaskada z auth.users) jest blokowane", async () => {
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set active = false where role = 'ADMIN' and active and id <> ${tAdmin.id}`;
      await tx`delete from auth.users where id = ${tAdmin.id}`;
    });
    expect(err.hint).toBe("LAST_ADMIN");
  });

  it("gdy jest inny aktywny ADMIN, dezaktywacja przechodzi (do ROLLBACK)", async () => {
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set active = false where id = ${tAdmin.id}`;
    });
    expect(err.message).toBe(NOT_BLOCKED);
  });

  it("w REPEATABLE READ odebranie uprawnień ADMIN jest odrzucane", async () => {
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set active = false where id = ${tAdmin2.id}`;
    }, "isolation level repeatable read");
    expect(err.hint).toBe("ISOLATION");
  });

  it("zmiany niedotyczące uprawnień ADMIN nie wymagają blokady (REPEATABLE READ)", async () => {
    const err = await inRolledBackTx(async (tx) => {
      await tx`update public.profiles set full_name = 'Inna nazwa' where id = ${tAdmin2.id}`;
    }, "isolation level repeatable read");
    expect(err.message).toBe(NOT_BLOCKED);
  });
});
