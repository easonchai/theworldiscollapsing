import { makePrisma, type PrismaClient } from "db";

// One client per process. Next dev reloads modules, so it hangs off globalThis.
const g = globalThis as typeof globalThis & { __twicPrisma?: PrismaClient };

export const prisma: PrismaClient = (g.__twicPrisma ??= makePrisma(process.env.DATABASE_URL ?? ""));
