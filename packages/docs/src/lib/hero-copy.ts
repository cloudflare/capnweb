/**
 * The landing hero's copy, in one place.
 *
 * The headline and tagline are here rather than inline in `index.mdx` because the
 * page's `<title>`, its OG card and the hero itself all want the same words, and
 * because the tagline's length decides how tall the hero's copy block is.
 *
 * The caption is here for a different reason: it is the text alternative for a
 * canvas, so it is the only description of the figure that a screen reader ever
 * gets. Keeping it beside the rest of the hero copy is what makes it obvious that
 * editing the animation means editing this too -- the numbers in it are the
 * numbers the scene draws, and nothing checks that they still agree.
 */

export const HERO_TITLE = "One round trip";

/** `label` is `bundle-size.json`'s measured figure, never a typed-in number. */
export const heroTagline = (label: string): string =>
  `A JavaScript-native, object-capability RPC system. Chain dependent calls and the whole chain resolves in a single trip. No schemas, no boilerplate, ${label}.`;

/** The accessible description of the hero figure. Says what it says, in words. */
export const HERO_FIGURE_CAPTION =
  "Two sequence diagrams side by side on one shared time axis. Without Cap'n Web, four " +
  "dependent calls are awaited one at a time, so each pays for its own round trip: eight " +
  "crossings and 400 milliseconds on a 100 millisecond link. With Cap'n Web, the same four " +
  "calls are pipelined, so all four messages travel together and the far end answers once: " +
  "two crossings and 100 milliseconds, leaving the remaining 300 milliseconds unspent.";
