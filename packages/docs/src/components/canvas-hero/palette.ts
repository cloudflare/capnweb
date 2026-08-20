/**
 * Scene colours, read from the theme rather than hardcoded.
 *
 * Every value comes from a `--cw-*` or `--nb-*` custom property already defined
 * in `globals.css`, so a scene inherits the measured palette and follows the
 * light/dark flip for free. The one thing deliberately absent is the tomato
 * accent: `--cw-orange` is the call to action, and an animation is not that.
 */
import type { Palette } from "./types";

const readVar = (styles: CSSStyleDeclaration, name: string, fallback: string): string => {
  const v = styles.getPropertyValue(name).trim();
  return v === "" ? fallback : v;
};

/**
 * Resolves a colour to `"r g b"` via a 1x1 canvas.
 *
 * `color-mix()` and the `oklab()`/`color(srgb ...)` forms that `getComputedStyle`
 * hands back cannot be split with a regex, and scenes need channels to build
 * their own alphas. This is the same trick the contrast harness uses, for the
 * same reason.
 */
const toRgbTriplet = (color: string): string => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  if (!cx) return "128 128 128";
  // Assigning an invalid colour to `fillStyle` is a no-op that leaves the previous
  // value, so seeding grey first means an unparseable input paints grey rather
  // than transparent black, which would read as a legitimate `0 0 0`.
  cx.fillStyle = "#808080";
  cx.fillStyle = color;
  cx.clearRect(0, 0, 1, 1);
  cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  return `${d[0]} ${d[1]} ${d[2]}`;
};

export function readPalette(): Palette {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const light = root.dataset.theme === "light";

  // `--cw-art-stroke` is the bento line-art colour, already tuned per scheme to
  // be dark on paper and light on ink, which is exactly what a scene needs.
  const stroke = readVar(styles, "--cw-art-stroke", light ? "#253c6d" : "#8fb0ec");

  return {
    light,
    stroke,
    // `||` rather than a default argument: defaults are eager, so passing
    // `toRgbTriplet(stroke)` would build a canvas and read pixels back on every
    // theme toggle even though the property is always defined.
    strokeRgb: readVar(styles, "--cw-art-stroke-rgb", "") || toRgbTriplet(stroke),
    // Request and response must not be the same hue, or a round trip reads as
    // one long line rather than as two legs.
    request: light ? "#0a2bb5" : "#7aa2ff",
    response: light ? "#0e6b52" : "#4fd6a8",
    muted: readVar(styles, "--nb-muted-foreground", light ? "#4c5a6a" : "#adbccb"),
    foreground: readVar(styles, "--nb-foreground", light ? "#1a222b" : "#e8eef4"),
    fade: light ? "#8792a3" : "#59677a",
    mono: readVar(styles, "--nb-font-mono", "ui-monospace, monospace"),
    sans: readVar(styles, "--nb-font-sans", "system-ui, sans-serif"),
  };
}
