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

/*
 * The headline, and also the seal's legend -- they are the same words because
 * the seal *is* the `<h1>`. See `StarBadge.astro`.
 *
 * Capitalised here and lowercased in CSS: the reference sets its "infinitely
 * faster!" in lower case, but `text-transform` does not touch the accessible
 * name, so a screen reader and a search result still get a sentence.
 */
export const HERO_TITLE = "One round trip!";

/** `label` is `bundle-size.json`'s measured figure, never a typed-in number. */
export const heroTagline = (label: string): string =>
  `A JavaScript-native, object-capability RPC system. Chain dependent calls and the whole chain resolves in a single trip. No schemas, no boilerplate, ${label}.`;

/** The accessible description of the hero figure. Says what it says, in words. */
export const HERO_FIGURE_CAPTION =
  "Two sequence diagrams side by side on one shared time axis, on a 100 millisecond link where " +
  "each call takes the server 10 milliseconds to handle. Without Cap'n Web, four dependent " +
  "calls are awaited one at a time, so each pays for its own round trip and its own visit to " +
  "the server: eight crossings, four handlers, 440 milliseconds. With Cap'n Web the same four " +
  "calls are pipelined into one batched request, and the far end runs all four handlers before " +
  "answering once: two crossings, the same four handlers, 140 milliseconds. The server does " +
  "identical work in both; the 300 milliseconds saved is the waiting that is gone.";
