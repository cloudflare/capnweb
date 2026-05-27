import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // map 'capnweb-validate' to the repo's local dist build so we can run using the local build.
      'capnweb-validate': path.resolve(__dirname, '../../packages/capnweb-validate/dist/index.mjs'),
    },
  },
  // Ensure modern output so top-level await is allowed (library uses it).
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
    supported: {
      'top-level-await': true,
    },
  },
})
