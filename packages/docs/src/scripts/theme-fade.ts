/**
 * How long a theme change takes to cross-fade.
 *
 * The number lives in CSS, as `--cw-theme-fade-ms` on `:root`, because the page
 * itself fades with a CSS transition. The two canvases and the demo iframes
 * cannot be cross-faded by the parent's CSS, so they tween their own palettes
 * and read the duration from here to stay in step. One number, four fades.
 *
 * The token is deliberately unitless: Chrome serialises a `200ms` custom property
 * back out as `.2s`, so reading the CSS time and calling `parseFloat` on it gives
 * 0.2, and everything downstream fades for a fifth of a millisecond.
 */
export function themeFadeMs(): number {
	const raw = getComputedStyle(document.documentElement).getPropertyValue('--cw-theme-fade-ms');
	const ms = Number.parseFloat(raw);
	return Number.isFinite(ms) && ms > 0 ? ms : 200;
}
