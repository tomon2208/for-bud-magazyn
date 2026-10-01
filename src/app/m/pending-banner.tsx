"use client";

import Link from "next/link";
import { usePendingReceipt } from "@/lib/pending-receipt";
import { formatQuantityUnit } from "@/lib/validation/stock";

/** Na ekranie głównym terminala: niepotwierdzone przyjęcie (np. po wygaśnięciu sesji i ponownym logowaniu). */
export function PendingReceiptBanner({ userId }: { userId: string }) {
  const pending = usePendingReceipt(userId);
  if (!pending) return null;
  return (
    <Link
      href="/m/przyjecie"
      role="alert"
      className="flex min-h-16 flex-col justify-center rounded-2xl bg-amber-100 px-4 py-3 text-amber-950 active:opacity-80"
    >
      <span className="text-lg font-bold">Niepotwierdzone przyjęcie — dokończ</span>
      <span className="text-base break-all">
        {formatQuantityUnit(pending.payload.quantity, pending.material.unit)} {pending.material.code} → {pending.location.code}
      </span>
    </Link>
  );
}
