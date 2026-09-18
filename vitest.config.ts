import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Native bundles and embedded PostgreSQL are resource-heavy. Bound process
    // concurrency; keep every test and its deadline, rather than overcommit RAM/CPU.
    maxWorkers: 2,
    include: ["src/**/*.test.ts", "scripts/sync/**/*.test.mjs"],
    environment: "node",
  },
});
