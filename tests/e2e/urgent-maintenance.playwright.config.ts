import {defineConfig,devices} from '@playwright/test'
import {fileURLToPath} from 'node:url'
const port=4191+Number(process.env.PLAYWRIGHT_PORT_OFFSET??0)
export default defineConfig({testDir:'.',testMatch:'urgent-maintenance-access.proof.ts',fullyParallel:true,workers:2,retries:0,reporter:'list',use:{trace:'retain-on-failure'},
  webServer:{command:'pnpm exec vite --config tests/fixtures/urgent-maintenance-vite.config.ts',cwd:fileURLToPath(new URL('../..',import.meta.url)),url:`http://127.0.0.1:${port}/tests/fixtures/urgent-maintenance-ui.html`,reuseExistingServer:false},
  projects:[{name:'desktop-chromium',use:{...devices['Desktop Chrome']}},{name:'mobile-chromium',use:{...devices['Pixel 7']}}],
})
