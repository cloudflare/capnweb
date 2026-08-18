/**
 * The scene registry, and the one list that says which scene each route shows.
 *
 * `CanvasHero.astro` takes a key from here, so a page names a scene rather than
 * importing a module. Every factory is statically imported, so a variant page
 * ships all of them in one chunk: that is fine for throwaway comparison pages,
 * and making it code-split would mean `mountCanvasHero` accepting a
 * `Promise<Scene>` to save a few kilobytes on pages that will not survive the
 * decision.
 */
import { VARIANT_SLUGS, type VariantSlug } from "../routes";
import type { SceneFactory } from "../types";
import { roundTripField } from "./round-trip-field";
import { relay } from "./relay";
import { reverse } from "./reverse";
import { sessionLoss } from "./session-loss";
import { amplify } from "./amplify";
import { streams } from "./streams";
import { pipelineLadder } from "./pipeline-ladder";
import { batchBody } from "./batch-body";
import { idTables } from "./id-tables";
import { mapReplay } from "./map-replay";
import { depth } from "./depth";
import { substitute } from "./substitute";
import { unpulled } from "./unpulled";

export const scenes = {
  "round-trip-field": roundTripField,
  relay,
  reverse,
  "session-loss": sessionLoss,
  amplify,
  streams,
  "pipeline-ladder": pipelineLadder,
  "batch-body": batchBody,
  "id-tables": idTables,
  "map-replay": mapReplay,
  depth,
  substitute,
  unpulled,
} satisfies Record<string, SceneFactory>;

export type SceneKey = keyof typeof scenes;

/** Title and one-line gloss, used by the variant switcher and each page's `<title>`. */
export const sceneMeta: Record<SceneKey, { title: string; blurb: string }> = {
  "round-trip-field": {
    title: "Round-trip field",
    blurb: "A drifting node network. Calls ride out together and one answer comes back.",
  },
  relay: {
    title: "Delegated authority",
    blurb: "A capability is granted, passed on, and then used directly by a third party.",
  },
  reverse: {
    title: "Direction reverses",
    blurb: "One route. A call goes out, is answered, and then the far end calls back.",
  },
  "session-loss": {
    title: "Session loss",
    blurb: "Every stub on one connection breaks in the same frame, then regrows elsewhere.",
  },
  amplify: {
    title: "Amplification",
    blurb: "One small call in, one small value out, and a detonation in between.",
  },
  streams: {
    title: "Multiplexed streams",
    blurb: "Three continuous flows sharing one cable, each at its own rate.",
  },
  "pipeline-ladder": {
    title: "Pipeline ladder",
    blurb: "Four dependent calls, awaited one at a time against pipelined, on one time axis.",
  },
  "batch-body": {
    title: "Batch body",
    blurb: "One HTTP body of newline-delimited JSON, and the reply line that never comes.",
  },
  "id-tables": {
    title: "Import and export tables",
    blurb: "IDs allocated by sign, a call going back the other way, and a release.",
  },
  "map-replay": {
    title: "Record and replay",
    blurb: "The callback runs once locally; the recorded instructions run once per element.",
  },
  depth: {
    title: "Depth is free",
    blurb: "The same four calls raced: eight crossings against two, and the idle time after.",
  },
  substitute: {
    title: "The hollow socket",
    blurb: "A call ships with a hole in it, and the far end drops the missing value in.",
  },
  unpulled: {
    title: "Only what was pulled",
    blurb: "Five calls run at the far end. Two answers come back, and three never move.",
  },
};

/**
 * Route slug to scene, with the canvas opacity each one wants.
 *
 * One list, because the mapping used to live in three: the registry's key order,
 * a hand-maintained array in the switcher, and page files each passing a number
 * and a scene independently, with nothing to stop them disagreeing.
 *
 * The slug is carried rather than derived from the index, because the routes are
 * no longer a clean sequence: the `1x` family are variations on scene 1 and are
 * named to say so, and deriving `/1a` from an array position would put the
 * relationship in the reader's head instead of in the code.
 *
 * The opacities are not uniform on purpose. A drifting node field is texture and
 * can sit near the reference's 0.42; a diagram made of 8px monospace has to be
 * legible, so it sits higher. The lane scenes are line work on a dimmed field,
 * which needs less than type but more than texture.
 */
export interface Variant {
  /** The route, without its leading slash. */
  slug: VariantSlug;
  scene: SceneKey;
  opacity: number;
}

export const VARIANTS = [
  { slug: "1", scene: "round-trip-field", opacity: 0.62 },
  { slug: "1a", scene: "relay", opacity: 0.66 },
  { slug: "1b", scene: "reverse", opacity: 0.66 },
  { slug: "1c", scene: "session-loss", opacity: 0.66 },
  { slug: "1d", scene: "amplify", opacity: 0.62 },
  { slug: "1e", scene: "streams", opacity: 0.66 },
  { slug: "2", scene: "pipeline-ladder", opacity: 0.8 },
  { slug: "3", scene: "batch-body", opacity: 0.88 },
  { slug: "4", scene: "id-tables", opacity: 0.85 },
  { slug: "5", scene: "map-replay", opacity: 0.85 },
  { slug: "6", scene: "depth", opacity: 0.78 },
  { slug: "7", scene: "substitute", opacity: 0.78 },
  { slug: "8", scene: "unpulled", opacity: 0.78 },
] as const satisfies readonly Variant[];

/**
 * Every declared route has a variant, and every variant has a declared route.
 *
 * `Variant["slug"]` already stops a typo, but it cannot catch the interesting
 * failure: adding a slug to `routes.ts` and forgetting the variant, which ships a
 * page that throws at build, or dropping a variant and leaving the sitemap filter
 * hiding a route that no longer exists. This is a type-level check, so it costs
 * nothing at runtime and fails at `astro check` instead of in the browser.
 */
type Covered = (typeof VARIANTS)[number]["slug"];
type Missing = Exclude<VariantSlug, Covered>;
const _allSlugsCovered: Missing extends never ? true : Missing = true;
void _allSlugsCovered;
if (VARIANTS.length !== VARIANT_SLUGS.length) {
  throw new Error(`canvas-hero: ${VARIANTS.length} variants for ${VARIANT_SLUGS.length} routes`);
}

export function variantBySlug(slug: string): Variant | undefined {
  return VARIANTS.find((v) => v.slug === slug);
}
