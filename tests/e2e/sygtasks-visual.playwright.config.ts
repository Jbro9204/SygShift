import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'sygtasks-theme-layout.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../outputs/sygtasks-redesign-visuals',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop-chromium' }],
})
