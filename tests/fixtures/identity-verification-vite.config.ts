import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const fixtureData = fileURLToPath(new URL('./identity-verification-data.ts', import.meta.url))
export default defineConfig({
  plugins: [react()], envDir: false,
  resolve: { alias: [
    { find: /.*\/lib\/supabase$/, replacement: fixtureData },
    { find: /.*\/lib\/sharedIdentitySession$/, replacement: fixtureData },
    { find: /^\.\/supabase$/, replacement: fixtureData },
    { find: /^\.\/sharedIdentitySession$/, replacement: fixtureData },
    { find: /.*\/data\/(mfa|securityKeys)$/, replacement: fixtureData },
  ] },
  server: { host: '127.0.0.1', port: 4197, strictPort: true },
})
