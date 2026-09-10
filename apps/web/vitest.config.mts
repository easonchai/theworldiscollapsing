import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Route handlers import through the `@/` alias tsconfig gives them, so the tests that call those
// handlers need the same alias here.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node" },
});
