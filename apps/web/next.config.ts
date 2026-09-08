import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge floats over the wall's chyron and the hero caption. This is a broadcast wall;
  // nothing floats on it that the station did not put there.
  devIndicators: false,
  transpilePackages: ["db", "contracts"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  // Prisma 7 generates TypeScript that imports itself with `.js` specifiers, which only tsc-style
  // resolution understands. Webpack maps them back to the real files; Turbopack cannot yet.
  experimental: { extensionAlias: { ".js": [".ts", ".js"] } },
};

export default nextConfig;
