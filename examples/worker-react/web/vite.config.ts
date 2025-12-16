import { defineConfig } from 'vite'
import path from 'node:path'

// Map 'capnweb' to the repo's local dist build so
// we can run using the local build.
export default defineConfig({
  resolve: {
    alias: {
      'capnweb': path.resolve(__dirname, '../../../dist/index.js'),
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
