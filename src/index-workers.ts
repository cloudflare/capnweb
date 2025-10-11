// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// When building for Cloudflare Workers, this file is the top-level module, instead of index.ts.
// This ensures that inject-workers-module.js gets imported before the rest of the library.
import "./inject-workers-module.js";
export * from "./index.js";
