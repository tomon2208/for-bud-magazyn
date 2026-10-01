import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { homePathForRole } from "@/lib/authorize";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Logowanie — FOR-BUD Magazyn" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getCurrentUser();
  if (user) redirect(homePathForRole(user.role));

  const { konto } = await searchParams;
  const inactive = konto === "nieaktywne";

  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold">FOR-BUD Magazyn</h1>
        <LoginForm inactive={inactive} />
      </div>
    </main>
  );
}
