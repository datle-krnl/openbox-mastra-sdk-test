import { defineConfig } from "tsup";

export default defineConfig({
  bundle: false,
  clean: true,
  dts: true,
  entry: ["src/**/*.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node24"
});
