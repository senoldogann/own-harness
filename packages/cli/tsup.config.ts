import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  splitting: false,
  shims: true,
  sourcemap: false,
  noExternal: [
    /^@own-harness\//,
    "commander",
    "execa",
    "fastify",
    "safe-regex2",
    "undici",
    "yaml",
    "zod"
  ]
})
