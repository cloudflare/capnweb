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

// The site's dark scheme, since a social card has no scheme to follow: the
// near-black with the blue undertone, the deep blue it sits on, and the orange
// edge -- which is the only place the spark appears here, and the only thing
// that makes one of these cards recognisable at thumbnail size.
export const ogCardConfig = {
  bgGradient: [
    [4, 7, 14],
    [7, 32, 65],
  ],
  border: { color: [246, 130, 31], width: 12, side: "inline-start" },
  padding: 96,
  fonts: ["./public/fonts/Inter-Bold.ttf"],
  font: {
    title: {
      color: [242, 247, 253],
      size: 64,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.1,
    },
    description: {
      color: [130, 153, 182],
      size: 32,
      weight: "Bold",
      families: ["Inter"],
      lineHeight: 1.3,
    },
  },
  format: "PNG",
} satisfies Partial<OGImageOptions>;
