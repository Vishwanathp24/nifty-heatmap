import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8100' } },
  // React in its own file: it rarely changes, so browsers keep it cached across deploys
  build: { rollupOptions: { output: { manualChunks: id => id.includes('node_modules') ? 'vendor' : undefined } } },
})
