import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

// Writes a max-level .br and .gz next to each built JS / CSS file; the server sends the
// smallest one the browser accepts (Brotli is ~15-20% smaller than on-the-fly gzip).
function precompress() {
  let assets
  return {
    name: 'precompress',
    apply: 'build',
    configResolved: c => { assets = join(resolve(c.root, c.build.outDir), c.build.assetsDir) },
    closeBundle() {
      for (const f of readdirSync(assets)) {
        if (!/\.(js|css|svg|json)$/.test(f)) continue
        const buf = readFileSync(join(assets, f))
        if (buf.length < 1024) continue
        writeFileSync(join(assets, f + '.br'), brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }))
        writeFileSync(join(assets, f + '.gz'), gzipSync(buf, { level: 9 }))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), precompress()],
  server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8100' } },
  // React in its own file: it rarely changes, so browsers keep it cached across deploys.
  // Other packages (OCR) stay in the lazy chunks that use them.
  build: { rollupOptions: { output: { manualChunks: id => /node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'vendor' : undefined } } },
})
