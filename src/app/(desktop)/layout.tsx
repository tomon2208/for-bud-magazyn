import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";
import { NavLink } from "@/components/nav-link";
import { requirePageRole } from "@/server/auth";
import { ROLE_LABELS } from "@/lib/validation/auth";

// Widok biurowy (desktop). PRODUKCJA pracuje na terminalu mobilnym /m.
export default async function DesktopLayout({ children }: LayoutProps<"/">) {
  const user = await requirePageRole("ADMIN", "BIURO");

  return (
    <div className="flex min-h-screen flex-1 flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b bg-sidebar p-4 md:w-60 md:border-r md:border-b-0 print:hidden">
        <Link href="/dashboard" className="text-lg font-semibold">
          FOR-BUD Magazyn
        </Link>
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Nawigacja główna">
          <NavLink href="/dashboard">Dashboard</NavLink>
          <NavLink href="/magazyn">Magazyn</NavLink>
          <NavLink href="/przyjecia">Przyjęcia</NavLink>
          <NavLink href="/wydania">Wydania</NavLink>
          <NavLink href="/zlecenia">Zlecenia</NavLink>
          <NavLink href="/historia">Historia ruchów</NavLink>
          <NavLink href="/materialy">Materiały</NavLink>
          <NavLink href="/dostawcy">Dostawcy</NavLink>
          <NavLink href="/lokalizacje">Lokalizacje</NavLink>
          {user.role === "ADMIN" && <NavLink href="/kategorie">Kategorie</NavLink>}
          {user.role === "ADMIN" && <NavLink href="/admin/uzytkownicy">Użytkownicy</NavLink>}
        </nav>
        <div className="mt-auto flex flex-col gap-2 text-sm">
          <div>
            <div className="font-medium">{user.fullName}</div>
            <div className="text-muted-foreground">
              {user.login} · {ROLE_LABELS[user.role]}
            </div>
          </div>
          {user.role === "ADMIN" && (
            <Link href="/m" className="text-sm underline underline-offset-4">
              Przejdź do widoku mobilnego
            </Link>
          )}
          <LogoutButton className="w-full" />
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8 print:p-0">{children}</main>
    </div>
  );
}
