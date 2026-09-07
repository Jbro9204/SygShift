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
const portOffset = Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)
const e2ePort = 4174 + portOffset
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
    trace: 'retain-on-failure',
  },
  webServer: [{
    command: `pnpm build && node tools/e2e-static-server.mjs ${e2ePort}`,
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
    reuseExistingServer: false,
    url: e2eBaseUrl,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/support-vite.config.ts',
    url: `http://127.0.0.1:${4185 + portOffset}/tests/fixtures/support-ui.html`,
    reuseExistingServer: false,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/clock-vite.config.ts',
    url: `http://127.0.0.1:${4186 + portOffset}/tests/fixtures/clock-ui.html`,
    reuseExistingServer: false,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/live-vite.config.ts',
    url: `http://127.0.0.1:${4187 + portOffset}/tests/fixtures/live-ui.html`,
    reuseExistingServer: false,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/notification-vite.config.ts',
    url: `http://127.0.0.1:${4188 + portOffset}/tests/fixtures/notification-ui.html`,
    reuseExistingServer: false,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/roles-vite.config.ts',
    url: `http://127.0.0.1:${4189 + portOffset}/tests/fixtures/roles-ui.html`,
    reuseExistingServer: false,
  }, {
    command: 'pnpm exec vite --config tests/fixtures/sphere-vite.config.ts',
    url: `http://127.0.0.1:${4190 + portOffset}/tests/fixtures/sphere-ui.html`,
    reuseExistingServer: false,
  }],
  projects: browserProjects,
})
