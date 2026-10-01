import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Bez incremental cache (R2) — aplikacja jest dynamiczna, a R2 wymaga płatnego konta.
export default defineCloudflareConfig();
