/**
 * Shared visual config for build-time OG cards.
 *
 * Edit this file to retune generated card colors, spacing, and fonts. Both
 * the per-page endpoint (`og/[...slug].ts`) and the homepage fallback
 * (`og.png.ts`) spread this object into `astro-og-canvas`.
 *
 * Leading underscore tells Astro to skip routing for this file — it sits
 * inside `src/pages/` to be next to its consumers, but it's not a route.
 */

import type { OGImageOptions } from "astro-og-canvas";

export const ogCardConfig = {
  bgGradient: [
    [11, 11, 12],
    [26, 26, 28],
  ],
  border: { color: [39, 39, 42], width: 2, side: "inline-start" },
  padding: 96,
  fonts: ["./public/fonts/Inter-Bold.ttf"],
  font: {
    title: {
      color: [250, 250, 250],
      size: 64,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.1,
    },
    description: {
      color: [161, 161, 170],
      size: 32,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.3,
    },
  },
  format: "PNG",
} satisfies Partial<OGImageOptions>;
