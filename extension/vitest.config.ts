import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only: no Chrome, no WXT runtime, no RawReader window. DOM tests opt in with
// `// @vitest-environment happy-dom` at the top of the file.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
  },
});
