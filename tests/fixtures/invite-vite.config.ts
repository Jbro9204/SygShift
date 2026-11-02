import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./invite-data.ts', import.meta.url))
export default defineConfig({
  plugins: [react()], envDir: false,
  resolve: { alias: [
    { find: /^\.\.\/data\/(adminUsers|auth|accessControl|platformPresence|platformLaunch)$/, replacement: fixture },
  ] },
  server: { host: '127.0.0.1', port: 4198, strictPort: true },
})
