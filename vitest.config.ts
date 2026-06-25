import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Pure deterministic engine tests only (lib/capital, lib/waterfall).
// No DOM, no Next runtime — these modules are framework-free by design.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    environment: 'node',
    include: ['lib/**/__tests__/**/*.test.ts'],
  },
})
