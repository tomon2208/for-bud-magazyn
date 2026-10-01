import { redirect } from "next/navigation";
import { getAuthState } from "@/server/auth";
import { homePathForRole } from "@/lib/authorize";

export default async function Home() {
  const state = await getAuthState();
  if (state.status === "active") redirect(homePathForRole(state.user.role));
  if (state.status === "inactive") redirect("/login?konto=nieaktywne");
  redirect("/login");
}
