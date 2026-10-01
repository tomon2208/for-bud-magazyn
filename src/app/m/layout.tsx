import { requirePageRole } from "@/server/auth";

// Terminal mobilny — osobny layout, nie pomniejszony desktop.
export default async function MobileLayout({ children }: LayoutProps<"/m">) {
  await requirePageRole("PRODUKCJA", "ADMIN");
  return <div className="flex min-h-dvh flex-1 flex-col bg-muted/40">{children}</div>;
}
