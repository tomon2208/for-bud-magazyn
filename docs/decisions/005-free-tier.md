# ADR 005 — Darmowe plany Cloudflare Workers i Supabase

## Decyzja

System musi działać w darmowych planach Cloudflare Workers i Supabase.
Aplikacja to jeden projekt Next.js wdrażany na Cloudflare Workers przez `@opennextjs/cloudflare`.

## Limity, których pilnujemy

Cloudflare Workers Free (do weryfikacji w aktualnej dokumentacji przy zmianach):
- rozmiar Workera ≤ 3 MiB gzip — nasz budżet: 2,5 MiB (`pnpm check:size`, także w CI),
- CPU ~10 ms / żądanie, 100 000 żądań / dzień, start Workera ≤ ~1 s.

Supabase Free:
- baza 500 MB, egress 5 GB / mies.,
- projekt usypiany po 7 dniach bez aktywności,
- brak kopii zapasowych → własny backup (`pg_dump` przez GitHub Actions) przed startem produkcji.

## Pomiar (Etap 0, 2026-10-01)

- Next.js 16.3.7 + @opennextjs/cloudflare 1.20.7, pusta aplikacja: **950 KiB gzip** (37% budżetu).
- Worker uruchomiony lokalnie (`wrangler dev`) — strona serwowana poprawnie.
- Do zrobienia: pomiar CPU na realnym deployu (wymaga konta Cloudflare).

## Konsekwencje

- Bez R2 (incremental cache) i Cloudflare Images — wymagają płatnych usług; `images.unoptimized`.
- Worker jest cienki: walidacja + wywołanie funkcji PostgreSQL. Ciężkie obliczenia w SQL.
- Parsowanie plików LiczOkno w przeglądarce.
- Każda nowa biblioteka serwerowa — sprawdzić wpływ na `pnpm check:size`.
- Plan B, jeśli limity CPU okażą się problemem: Next.js `output: 'export'` (statyczne assety) + mały Worker API (Hono). Logika stocku zostaje w PostgreSQL, więc zmiana dotyczy tylko warstwy API.

## Uwagi środowiskowe (Windows)

- `nodeLinker: hoisted` w `pnpm-workspace.yaml` — OpenNext przy budowie tworzy symlinki, których Windows bez trybu dewelopera nie pozwala tworzyć.
- Dozwolone skrypty instalacyjne: `esbuild` i `workerd` (natywne binaria wymagane przez wrangler) oraz `supabase` (pobiera binarkę Supabase CLI używaną przez `pnpm db:push`; tylko devDependency, nie trafia do Workera).
