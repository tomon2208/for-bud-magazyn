# Architektura

## Docelowy układ

Browser / PWA
↓
Next.js
↓
Cloudflare Workers
↓
Supabase PostgreSQL

Supabase Auth odpowiada za uwierzytelnianie.
Cloudflare jest główną warstwą edge/API.

## Zasada

Frontend nie powinien samodzielnie decydować o stanie magazynu.
Backend jest źródłem prawdy dla operacji magazynowych.

## Główne obszary

- materials
- locations
- stock
- stock_movements
- production_orders
- requirements
- reservations
- suppliers
- users / roles
- inventory

## Przyszłość

Możliwe później:
- Cloudflare R2 na dokumenty,
- integracje,
- automatyczne zamówienia,
- bardziej zaawansowane profile/resztki,
- raporty,
- druk etykiet.
