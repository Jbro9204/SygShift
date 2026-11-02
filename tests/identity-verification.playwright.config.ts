import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: './identity-verification', testMatch: 'identity-verification-session.spec.ts',
  fullyParallel: true, workers: 2, retries: 0, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4197', trace: 'retain-on-failure' },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'pnpm exec vite --config tests/fixtures/identity-verification-vite.config.ts',
    url: 'http://127.0.0.1:4197/tests/fixtures/identity-verification-ui.html',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
})
