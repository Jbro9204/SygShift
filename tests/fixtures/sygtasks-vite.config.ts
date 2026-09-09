import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envDir: false,
  server: {
    host: '127.0.0.1',
    port: 4191 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0),
    strictPort: true,
    watch: { ignored: ['**/outputs/**', '**/test-results/**'] },
  },
})
