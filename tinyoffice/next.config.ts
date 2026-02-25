import type { NextConfig } from "next";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Read API key from TinyClaw settings for auto-configuration
function loadApiKey(): string {
  // Env var takes priority
  if (process.env.NEXT_PUBLIC_API_KEY) return process.env.NEXT_PUBLIC_API_KEY;

  // Read from settings.json
  const paths = [
    join(__dirname, "..", ".tinyclaw", "settings.json"),
    join(process.env.TINYCLAW_HOME || "", "settings.json"),
    join(process.env.HOME || "", ".tinyclaw", "settings.json"),
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const settings = JSON.parse(readFileSync(p, "utf8"));
        if (settings?.api?.api_key) return settings.api.api_key;
      }
    } catch { /* ignore */ }
  }
  return "";
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_KEY: loadApiKey(),
  },
};

export default nextConfig;
