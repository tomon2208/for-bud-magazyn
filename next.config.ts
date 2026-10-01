import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  // AGENTS.md/CLAUDE.md nie są generowane automatycznie — odsyłacz do docs jest w CLAUDE.md.
  agentRules: false,
  // Biblioteki QR działają wyłącznie w przeglądarce (dynamic import w useEffect/handlerze). Webpack i tak
  // generowałby dla nich chunki SSR, a OpenNext wkleiłby je do Workera — w buildzie serwerowym podstawiamy
  // pusty moduł (ADR 008). Kod klienta nie jest dotknięty.
  webpack(config, { isServer }) {
    if (isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = { ...config.resolve.alias, "qr-scanner": false, "qrcode-generator": false };
    }
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
