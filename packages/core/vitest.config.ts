import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    server: {
      deps: {
        external: ["node:sqlite"],
        inline: []
      }
    },
    resolve: {
      preserveSymlinks: true
    },
    coverage: {
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60
      }
    }
  }
})
