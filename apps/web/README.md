# `apps/web`: the wall and the betting UI

Next.js 16 app router. The wall (`/`), a channel (`/c/<id>`), an event (`/e/<id>`), the markets
list, positions, and `/verify`.

```bash
pnpm --filter web dev            # http://localhost:3000
pnpm --filter web test
```

It runs on **webpack**, not Turbopack (`next dev --webpack`): Prisma 7 generates TypeScript that
imports itself with `.js` specifiers, which Turbopack cannot resolve. Reasons and the way out are in
[`docs/CONTRACTS.md`](../../docs/CONTRACTS.md), "Web env".

Env vars go in `apps/web/.env.local` (gitignored); copy `.env.local.example`. The full local
walkthrough is [`docs/LOCAL.md`](../../docs/LOCAL.md); the route handlers, the `EventPublic` shape
and the wallet hook are in [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md).
