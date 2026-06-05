import { defineConfig } from 'vite'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')

export default defineConfig({
  // This example aliases packages to local monorepo source. External projects
  // using the published packages should not need this `resolve.alias` block.
  resolve: {
    alias: {
      'capnweb': path.resolve(repoRoot, 'src/index.ts'),
    },
  },
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
    supported: {
      'top-level-await': true,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
})
