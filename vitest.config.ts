import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: { __DSH_RACCOON_VERSION__: JSON.stringify(PACKAGE_VERSION) },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
