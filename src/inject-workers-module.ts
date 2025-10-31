// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { WORKERS_MODULE_SYMBOL } from "./symbols.js";

// Import cloudflare:workers and stick it in the global scope where in can be used conditionally.
// As long as inject-workers-module.ts is imported before the rest of the library, this allows the
// library to set up automatic interoperability with Cloudflare Workers' built-in RPC.
//
// Meanwhile, we define our `exports` in package.json such that when building on Workers, this
// module is in fact imported first.
import * as cfw from "cloudflare:workers";
(globalThis as any)[WORKERS_MODULE_SYMBOL] = cfw;
