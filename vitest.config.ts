// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    target: 'es2022', // Transpile using syntax for browser compatibility
  },
  test: {
    globalSetup: ['__tests__/test-server.ts'],
    projects: [
      // Node.js
      {
        test: {
          name: 'node',
          include: ['__tests__/index.test.ts'],
          environment: 'node',
        },
      },

      // Cloudflare Workers
      {
        test: {
          name: 'workerd',
          include: ['__tests__/index.test.ts', '__tests__/workerd.test.ts'],
          pool: '@cloudflare/vitest-pool-workers',
          poolOptions: {
            workers: {
              miniflare: {
                compatibilityDate: '2025-07-01',
                compatibilityFlags: ["expose_global_message_channel"],

                // Define a backend worker to test server-side functionality. The tests will
                // talk to it over a service binding. (Only the workerd client tests will talk
                // to this, not Node nor browsers.)
                serviceBindings: {
                  testServer: "test-server-workerd",
                },
                workers: [
                  {
                    name: "test-server-workerd",
                    compatibilityDate: '2025-07-01',
                    modules: [
                      {
                        type: "ESModule",
                        path: "./__tests__/test-server-workerd.js",
                      },
                      {
                        type: "ESModule",
                        path: "./dist/index-workers.js",
                      },
                    ],
                    durableObjects: {
                      TEST_DO: "TestDo"
                    }
                  }
                ]
              },
            },
          },
        },
      },

      // Browsers which natively support the `using` keyword (Explicit Resource Management).
      {
        test: {
          name: 'browsers-with-using',
          include: ['__tests__/index.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            instances: [
              // Currently only Chromium supports this.
              { browser: 'chromium' },
            ],
            headless: true,
            screenshotFailures: false,  // there's nothing to screenshot
          },
        },
      },

      // Browsers with the `using` keyword transpiled to try/catch.
      {
        esbuild: {
          target: 'es2022',
        },
        test: {
          name: 'browsers-without-using',
          include: ['__tests__/index.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            instances: [
              // We re-test Chromium in this mode since it's likely users will want to serve the
              // same JavaScript to all browsers, so will have to use this mode until `using`
              // becomes widely available.
              { browser: 'chromium' },
              { browser: 'firefox' },
              { browser: 'webkit' },
            ],
            headless: true,
            screenshotFailures: false,  // there's nothing to screenshot
          },
        },
      },
    ],
  },
})