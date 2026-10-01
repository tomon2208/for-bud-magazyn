import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  // AGENTS.md/CLAUDE.md nie są generowane automatycznie — odsyłacz do docs jest w CLAUDE.md.
  agentRules: false,
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
