/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  // tsconfig keeps JSX as-is for Next; tests need it compiled to render components.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    alias: {
      "@/*": "./*",
    },
  },
});
