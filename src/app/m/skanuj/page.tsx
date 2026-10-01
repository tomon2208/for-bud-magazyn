import type { Metadata } from "next";
import { requirePageRole } from "@/server/auth";
import { BackLink } from "../back-link";
import { Scanner } from "./scanner";

export const metadata: Metadata = { title: "Skanuj — FOR-BUD Magazyn" };

export default async function ScanPage() {
  await requirePageRole("PRODUKCJA", "ADMIN");
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <BackLink />
        <h1 className="pr-3 text-xl font-bold">Skanuj lokalizację</h1>
      </header>
      <Scanner />
    </div>
  );
}
