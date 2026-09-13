import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations only. `migrate deploy` holds a session-level advisory lock, and a transaction-mode
  // pooler hands the backend back to the pool without releasing it — the lock leaks and every later
  // deploy times out on P1002. Neon's unpooled endpoint has no pool to leak into. The runtime
  // client keeps using the pooled DATABASE_URL.
  datasource: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL },
});
