import { defineConfig } from 'vite'
import path from 'node:path'
import { capnwebValidate } from '../../../packages/capnweb-validate/src/plugin.ts'

const repoRoot = path.resolve(__dirname, '../../..')

export default defineConfig({
  plugins: [
    capnwebValidate.vite({
      cwd: __dirname,
      tsconfig: 'tsconfig.json',
    }),
  ],
  // This example aliases packages to local monorepo source. External projects
  // using the published packages should not need this `resolve.alias` block.
  resolve: {
    alias: {
      'capnweb-validate/internal/core': path.resolve(repoRoot, 'packages/capnweb-validate/src/internal/core.ts'),
      'capnweb-validate/internal': path.resolve(repoRoot, 'packages/capnweb-validate/src/internal/runtime.ts'),
      'capnweb-validate': path.resolve(repoRoot, 'packages/capnweb-validate/src/index.ts'),
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
