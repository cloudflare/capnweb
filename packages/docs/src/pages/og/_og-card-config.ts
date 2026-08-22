/**
 * Shared visual config for build-time OG cards.
 *
 * Edit this file to retune generated card colors, spacing, and fonts. Both
 * the per-page endpoint (`og/[...slug].ts`) and the homepage fallback
 * (`og.png.ts`) spread this object into `astro-og-canvas`.
 *
 * Leading underscore tells Astro to skip routing for this file -- it sits
 * inside `src/pages/` to be next to its consumers, but it's not a route.
 */

import type { OGImageOptions } from "astro-og-canvas";

// The site's dark scheme, since a social card has no scheme to follow.
//
// The background and the mark are both generated art, not styling done here:
// `packages/docs/scripts/build-wordmark.mjs` emits them from the same geometry
// as the README banner, so the card and the banner cannot drift apart. This is
// why the band is a `bgImage` rather than a `bgGradient` -- `astro-og-canvas`
// takes a list of gradient stops, and the band is a linear gradient with two
// elliptical accents over it, which that cannot express.
//
// `bgGradient` stays as the fallback the card falls back to if the image is
// ever missing, in the band's own colours rather than the old charcoal.
export const ogCardConfig = {
  bgImage: { path: "./og-assets/og-band.png", fit: "cover" },
  bgGradient: [
    [10, 20, 36],
    [10, 35, 32],
  ],
  // 240 rather than the mark's natural width: the card is 630 tall and the
  // three-line description is what runs out of room first.
  logo: { path: "./og-assets/og-mark.png", size: [240] },
  // Drawn over by `bgImage`, which carries the same edge at the same width.
  // Kept so the no-image fallback still has one.
  border: { color: [246, 130, 31], width: 12, side: "inline-start" },
  padding: 96,
  // Build-time only, and deliberately not under `public/`, where the starter
  // puts it: these paths are resolved from the project root when the cards are
  // rasterized, and nothing ever requests the files over HTTP. Left in `public/`
  // they are copied into `dist/` and deployed -- assets in the store that no
  // page links to. The rendered cards are byte-identical either way. The same
  // reasoning puts the card art in `og-assets/`.
  fonts: ["./fonts/Inter-Bold.ttf"],
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
