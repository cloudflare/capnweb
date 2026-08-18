/**
 * The landing hero's headline and tagline, in one place.
 *
 * The `/1`../`/5` backdrop comparison pages render the same hero, and the copy
 * used to be hand-duplicated into `HeroVariantPage.astro`. That is worse than the
 * usual copy-paste: the tagline's length decides how tall `.cw-hero-scrim` is, and
 * that box is exactly the `KeepOut` geometry the canvas scenes lay themselves out
 * against. Editing the landing tagline alone would leave all five comparison pages
 * judging backdrops against boxes the real page no longer has.
 */

export const HERO_TITLE = "One round trip";

/** `label` is `bundle-size.json`'s measured figure, never a typed-in number. */
export const heroTagline = (label: string): string =>
  `A JavaScript-native, object-capability RPC system. Chain dependent calls and the whole chain resolves in a single trip. No schemas, no boilerplate, ${label}.`;
