"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";

/** Duże pole wyszukiwania; fraza w URL (?q=), dane pobiera serwer. */
export function LocationSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);

  useEffect(() => {
    if (q.trim() === initial) return;
    const timer = setTimeout(() => {
      const trimmed = q.trim();
      router.replace(trimmed ? `/m/lokalizacje?q=${encodeURIComponent(trimmed)}` : "/m/lokalizacje");
    }, 300);
    return () => clearTimeout(timer);
  }, [q, initial, router]);

  return (
    <Input
      type="search"
      aria-label="Szukaj lokalizacji"
      placeholder="Szukaj kodu lub nazwy"
      value={q}
      maxLength={MAX_SEARCH_LENGTH}
      onChange={(e) => setQ(e.target.value)}
      autoComplete="off"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
      className="h-14 rounded-xl px-4 text-xl"
    />
  );
}
