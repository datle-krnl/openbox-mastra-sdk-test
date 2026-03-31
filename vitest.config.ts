import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      all: false,
      exclude: [
        ".reference/**",
        "dist/**",
        "examples/**",
        "node_modules/**",
        "test/fixtures/**",
        "vitest.config.ts",
        "tsup.config.ts"
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        branches: 70,
        functions: 90,
        lines: 75,
        statements: 75
      }
    },
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"]
  }
});
