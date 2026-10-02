"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { MAX_SEARCH_LENGTH } from "@/lib/validation/catalog";

/** Duże pole wyszukiwania materiału; fraza w URL (?q=), dane pobiera serwer. */
export function MaterialSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);

  useEffect(() => {
    if (q.trim() === initial) return;
    const timer = setTimeout(() => {
      const trimmed = q.trim();
      router.replace(trimmed ? `/m/szukaj?q=${encodeURIComponent(trimmed)}` : "/m/szukaj");
    }, 300);
    return () => clearTimeout(timer);
  }, [q, initial, router]);

  return (
    <Input
      type="search"
      aria-label="Szukaj materiału"
      placeholder="Kod lub nazwa materiału"
      value={q}
      maxLength={MAX_SEARCH_LENGTH}
      onChange={(e) => setQ(e.target.value)}
      autoFocus
      autoComplete="off"
      autoCapitalize="characters"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
      className="h-14 rounded-xl px-4 text-xl"
    />
  );
}
