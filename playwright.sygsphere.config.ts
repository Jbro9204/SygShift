import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({ ...base, testMatch: ['sygsphere.spec.ts', 'time-clock-workflow.spec.ts'] })
