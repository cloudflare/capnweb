/**
 * The single mount registration for every canvas scene on a page.
 *
 * Both `CanvasHero.astro` (backdrop) and `CanvasFigure.astro` (foreground figure)
 * need the same wiring: find the element, look up the scene by its data
 * attribute, hand it to the harness. When each component carried its own copy of
 * that `<script>`, a page holding both registered the same selector twice and the
 * harness appended two canvases to one container -- which on `/9` drew the whole
 * comparison figure a second time underneath the first.
 *
 * Both components now import this module with a byte-identical `<script>`, so
 * Astro hoists and dedupes it to one bundle. `mountCanvasHero` also refuses to
 * mount an element twice, because deduping by content hash is a build detail to
 * lean on for size, not for correctness.
 */
import { mount } from "@cloudflare/nimbus-docs/client";
import { mountCanvasHero } from "./canvas-hero.client";
import { scenes, type SceneKey } from "./scenes";

mount("[data-cw-canvas-hero]", (root) => {
  if (!(root instanceof HTMLElement)) return () => {};
  const key = root.dataset.scene as SceneKey | undefined;
  const factory = key ? scenes[key] : undefined;
  if (!factory) return () => {};
  return mountCanvasHero(root, factory);
});
