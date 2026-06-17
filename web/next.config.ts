import type { NextConfig } from "next";
import { join } from "node:path";

// Proxy /api/* to the Hono backend so cookies stay same-origin (session HttpOnly cookie works).
// Backend may 404/500 while built in parallel — pages must tolerate that.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:33491";

const nextConfig: NextConfig = {
  // Root must be the repo root (one level up) so the bundler can resolve `@be/*` -> `../src/*`,
  // the shared Zod schemas. Pinning to web/ would put src/ outside root and break the build.
  turbopack: { root: join(__dirname, "..") },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/:path*` }];
  },
};

export default nextConfig;
