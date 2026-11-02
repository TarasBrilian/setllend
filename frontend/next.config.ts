import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// All variables live in the root .env (SOT/repo-structure.md). Vercel sets them in its dashboard instead.
const rootEnv = resolve(process.cwd(), "../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
