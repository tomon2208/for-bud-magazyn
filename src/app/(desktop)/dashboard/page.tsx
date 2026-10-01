import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageRole } from "@/server/auth";
import { ROLE_LABELS } from "@/lib/validation/auth";

export const metadata: Metadata = { title: "Dashboard — FOR-BUD Magazyn" };

export default async function DashboardPage() {
  const user = await requirePageRole("ADMIN", "BIURO");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle>Witaj, {user.fullName}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          Zalogowano jako <strong className="text-foreground">{user.login}</strong> z rolą{" "}
          <strong className="text-foreground">{ROLE_LABELS[user.role]}</strong>. Moduły magazynowe
          pojawią się tu w kolejnych etapach.
        </CardContent>
      </Card>
    </div>
  );
}
