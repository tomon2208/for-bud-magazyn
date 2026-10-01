"use client";

import Link from "next/link";
import { usePendingOperation, type PendingOperation } from "@/lib/pending-operation";
import type { OperationKind } from "@/lib/stock-client";
import { formatQuantityUnit } from "@/lib/validation/stock";

const META: Record<OperationKind, { href: string; title: string }> = {
  RECEIPT: { href: "/m/przyjecie", title: "Niepotwierdzone przyjęcie — dokończ" },
  ISSUE: { href: "/m/wydanie", title: "Niepotwierdzone wydanie — dokończ" },
  TRANSFER: { href: "/m/przesuniecie", title: "Niepotwierdzone przesunięcie — dokończ" },
};

function describe(p: PendingOperation): string {
  const qty = formatQuantityUnit(p.payload.quantity, p.ctx.material.unit);
  if (p.kind === "RECEIPT") {
    const r = p as PendingOperation<"RECEIPT">;
    return `${qty} ${r.ctx.material.code} → ${r.ctx.location.code}`;
  }
  if (p.kind === "ISSUE") {
    const i = p as PendingOperation<"ISSUE">;
    const target = i.ctx.target.kind === "order" ? i.ctx.target.name : i.ctx.target.label;
    return `${qty} ${i.ctx.material.code} z ${i.ctx.location.code} · ${target}`;
  }
  const t = p as PendingOperation<"TRANSFER">;
  return `${qty} ${t.ctx.material.code}: ${t.ctx.from.code} → ${t.ctx.to.code}`;
}

/** Na ekranie głównym terminala: niepotwierdzone operacje (np. po wygaśnięciu sesji i ponownym logowaniu). */
export function PendingOperationsBanner({ userId }: { userId: string }) {
  const receipt = usePendingOperation("RECEIPT", userId);
  const issue = usePendingOperation("ISSUE", userId);
  const transfer = usePendingOperation("TRANSFER", userId);
  const pending = [receipt, issue, transfer].filter((p): p is NonNullable<typeof p> => p !== null) as PendingOperation[];
  if (pending.length === 0) return null;
  return (
    <>
      {pending.map((p) => (
        <Link
          key={p.kind}
          href={META[p.kind].href}
          role="alert"
          className="flex min-h-16 flex-col justify-center rounded-2xl bg-amber-100 px-4 py-3 text-amber-950 active:opacity-80"
        >
          <span className="text-lg font-bold">{META[p.kind].title}</span>
          <span className="text-base break-all">{describe(p)}</span>
        </Link>
      ))}
    </>
  );
}
