import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Render actual route-management components against synthetic memory only.
export default defineConfig({
  plugins: [react()], envDir: false, cacheDir: '.work/vite-patrol-route-fixture',
  resolve: { alias: [
    { find: /.*\/data\/patrol$/, replacement: fileURLToPath(new URL('./patrol-route-data.ts', import.meta.url)) },
    { find: /.*\/lib\/supabase$/, replacement: fileURLToPath(new URL('./patrol-route-data.ts', import.meta.url)) },
  ] },
  server: { host: '127.0.0.1', port: 4281, strictPort: true },
})
