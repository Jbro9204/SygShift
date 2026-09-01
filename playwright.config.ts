import { defineConfig, devices } from '@playwright/test'

const installedBrowser = process.env.PLAYWRIGHT_CHANNEL === 'chrome' || process.env.PLAYWRIGHT_CHANNEL === 'msedge'
  ? { channel: process.env.PLAYWRIGHT_CHANNEL }
  : {}
const browserProjects = process.env.PLAYWRIGHT_BROWSER === 'firefox'
  ? [{ name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } }]
  : [
      { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], ...installedBrowser } },
      { name: 'mobile-chromium', use: { ...devices['Pixel 7'], ...installedBrowser } },
    ]
const e2ePort = 4174
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: process.env.CI ? undefined : 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: e2eBaseUrl,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `pnpm build && node tools/e2e-static-server.mjs ${e2ePort}`,
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
    reuseExistingServer: false,
    url: e2eBaseUrl,
  },
  projects: browserProjects,
})
