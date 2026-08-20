/**
 * The hero backdrop comparison routes, as plain data.
 *
 * This is separate from `scenes/index.ts` on purpose. Three things need to agree
 * on what these routes are -- the pages, the sitemap filter in `astro.config.ts`,
 * and `BaseLayout`'s `cw-home` test -- and the config is loaded by Astro outside
 * the app's module graph, so having it import the scene registry would drag every
 * scene factory into config evaluation to read a list of strings.
 *
 * So the list lives here with no imports at all, and `scenes/index.ts` is
 * type-checked against it: `VARIANTS` must cover exactly these slugs, no more and
 * no fewer, or the build fails rather than quietly shipping a route the sitemap
 * still advertises.
 */
export const VARIANT_SLUGS = [
  "1",
  "1a",
  "1b",
  "1c",
  "1d",
  "1e",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
] as const;

export type VariantSlug = (typeof VARIANT_SLUGS)[number];

/** True for a hero backdrop comparison route, with or without a trailing slash. */
export function isVariantPath(pathname: string): boolean {
  const slug = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return (VARIANT_SLUGS as readonly string[]).includes(slug);
}
