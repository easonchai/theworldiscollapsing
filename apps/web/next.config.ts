import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["db", "contracts"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default nextConfig;
