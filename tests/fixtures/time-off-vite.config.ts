import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const fixtureData = fileURLToPath(new URL('./time-off-data.ts', import.meta.url))

export default defineConfig({
  plugins: [react()],
  envDir: false,
  resolve: {
    alias: [
      { find: /.*\/data\/requests$/, replacement: fixtureData },
      { find: /.*\/lib\/supabase$/, replacement: fixtureData },
    ],
  },
})
