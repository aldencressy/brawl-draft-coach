// Tests run from the repo root; vite.config.ts is for the UI (root: web/).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
