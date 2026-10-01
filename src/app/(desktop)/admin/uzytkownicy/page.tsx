import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePageRole } from "@/server/auth";
import { listUsers } from "@/server/users";
import { UsersAdmin } from "./users-admin";

export const metadata: Metadata = { title: "Użytkownicy — FOR-BUD Magazyn" };

export default async function UsersPage() {
  const user = await requirePageRole("ADMIN");
  const result = await listUsers(await createSupabaseServerClient());

  return (
    <div className="max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">Użytkownicy</h1>
      {result.ok ? (
        <UsersAdmin users={result.data} currentUserId={user.id} />
      ) : (
        <p role="alert" className="text-destructive">
          Nie udało się wczytać listy użytkowników.
        </p>
      )}
    </div>
  );
}
