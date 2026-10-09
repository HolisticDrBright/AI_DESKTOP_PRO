import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Next.js needs `jsx: "preserve"` in tsconfig, which leaves the test transform unable to
  // parse the JSX in a component. This overrides it for the test compile only; tsconfig and
  // the Next build are untouched.
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
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
