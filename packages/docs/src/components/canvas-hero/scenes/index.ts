/**
 * The scene registry, and the one list that says which scene each route shows.
 *
 * `CanvasHero.astro` takes a key from here, so a page names a scene rather than
 * importing a module. All five factories are statically imported, so a variant
 * page ships all five scenes in one chunk: that is fine for throwaway comparison
 * pages, and making it code-split would mean `mountCanvasHero` accepting a
 * `Promise<Scene>` to save a couple of kilobytes on pages that will not survive
 * the decision.
 */
import type { SceneFactory } from "../types";
import { roundTripField } from "./round-trip-field";
import { pipelineLadder } from "./pipeline-ladder";
import { batchBody } from "./batch-body";
import { idTables } from "./id-tables";
import { mapReplay } from "./map-replay";

export const scenes = {
  "round-trip-field": roundTripField,
  "pipeline-ladder": pipelineLadder,
  "batch-body": batchBody,
  "id-tables": idTables,
  "map-replay": mapReplay,
} satisfies Record<string, SceneFactory>;

export type SceneKey = keyof typeof scenes;

/** Title and one-line gloss, used by the variant switcher and each page's `<title>`. */
export const sceneMeta: Record<SceneKey, { title: string; blurb: string }> = {
  "round-trip-field": {
    title: "Round-trip field",
    blurb: "A drifting node network. Calls ride out together and one answer comes back.",
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
};

/**
 * Route number to scene, with the canvas opacity each one wants.
 *
 * One list, because the mapping used to live in three: the registry's key order,
 * a hand-maintained array in the switcher, and five page files each passing `n`
 * and `scene` independently, with nothing to stop them disagreeing.
 *
 * The opacities are not uniform on purpose. A drifting node field is texture and
 * can sit near the reference's 0.42; a diagram made of 8px monospace has to be
 * legible, so it sits higher.
 */
export const VARIANTS: { scene: SceneKey; opacity: number }[] = [
  { scene: "round-trip-field", opacity: 0.62 },
  { scene: "pipeline-ladder", opacity: 0.8 },
  { scene: "batch-body", opacity: 0.88 },
  { scene: "id-tables", opacity: 0.85 },
  { scene: "map-replay", opacity: 0.85 },
];
