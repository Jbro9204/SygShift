import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({ plugins: [react()], envDir: false, resolve: { alias: [{ find: /.*\/lib\/supabase$/, replacement: fileURLToPath(new URL('./sphere-data.ts', import.meta.url)) }] }, server: { host: '127.0.0.1', port: 4190, strictPort: true } })
