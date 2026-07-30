import { resolve } from "node:path";

import type { NextConfig } from "next";

try {
  process.loadEnvFile(resolve(process.cwd(), "../../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@seedance/shared"],
  async rewrites() {
    const apiInternalUrl =
      process.env.API_INTERNAL_URL?.replace(/\/$/, "") ??
      "http://127.0.0.1:43171";
    return [
      {
        source: "/api/:path*",
        destination: `${apiInternalUrl}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
