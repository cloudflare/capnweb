/**
 * Renders a page's social card to PNG bytes.
 *
 * Satori lays the text out (it does the line breaking, which is the only part
 * that genuinely needs font metrics), resvg rasterizes. Both are build-time
 * only -- no font and no rasterizer is ever shipped to a browser, which is why
 * adding them does not undo the site's no-web-fonts stance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { networkSvg, seedFrom } from './og-network.js';

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * Where the fonts live on disk.
 *
 * Not `import.meta.url`: Astro bundles this module into `dist/.prerender/`
 * before running it, so a URL relative to the source file resolves to a
 * directory that does not exist. The project root is the stable anchor --
 * both `astro dev` and `astro build` run with it as the working directory --
 * and the repo root is accepted too, for anyone running a script from there.
 */
const FONT_DIRS = [
	path.join(process.cwd(), 'src/assets/fonts'),
	path.join(process.cwd(), 'packages/docs/src/assets/fonts'),
	fileURLToPath(new URL('../assets/fonts/', import.meta.url)),
];

function readFont(file: string): Buffer {
	for (const dir of FONT_DIRS) {
		const candidate = path.join(dir, file);
		if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
	}
	throw new Error(
		`Social-card font "${file}" not found. Looked in:\n  ${FONT_DIRS.join('\n  ')}\n` +
			`Run \`npm run og:fonts\` in packages/docs to regenerate the subsets.`,
	);
}

/**
 * Inter, subset to the characters the site's titles actually use. If a new
 * page introduces a glyph outside that set it will render as a blank box, so
 * the subset list in `scripts/build-og-fonts.mjs` is the thing to update.
 */
const fonts = [
	{ name: 'Inter', data: readFont('inter-regular-subset.ttf'), weight: 400 as const, style: 'normal' as const },
	{ name: 'Inter', data: readFont('inter-semibold-subset.ttf'), weight: 600 as const, style: 'normal' as const },
];

export interface CardInput {
	title: string;
	/** Sidebar group, e.g. "Guides". Omitted on the landing page. */
	section?: string;
	description?: string;
	/** Chooses which network gets drawn. The page slug, normally. */
	seed: string;
}

const INK = '#f2f7fd';
const DIM = '#8299b6';
const AZURE = '#4db4ff';
const ORANGE = '#f6821f';

/** Trim to a whole word, so a card never ends mid-syllable. */
function clamp(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit);
	const lastSpace = cut.lastIndexOf(' ');
	return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:\s]+$/, '')}...`;
}

/** The three-node mark from the favicon, at card scale. */
function logoMark() {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 32 32">` +
		`<line x1="6" y1="23" x2="16" y2="8" stroke="${AZURE}" stroke-width="2.2" stroke-opacity="0.9"/>` +
		`<line x1="16" y1="8" x2="26" y2="20" stroke="${AZURE}" stroke-width="2.2" stroke-opacity="0.9"/>` +
		`<line x1="6" y1="23" x2="26" y2="20" stroke="${AZURE}" stroke-width="2.2" stroke-opacity="0.45"/>` +
		`<circle cx="6" cy="23" r="4" fill="${AZURE}"/>` +
		`<circle cx="26" cy="20" r="4" fill="${AZURE}"/>` +
		`<circle cx="16" cy="8" r="4.6" fill="${ORANGE}"/>` +
		`</svg>`;
	return {
		type: 'img',
		props: { width: 40, height: 40, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` },
	};
}

/**
 * Satori takes a React-element-shaped tree. We hand-build it rather than add a
 * JSX pipeline to a project that otherwise has no need for one.
 */
function node(type: string, props: Record<string, unknown>, children?: unknown) {
	return { type, props: children === undefined ? props : { ...props, children } };
}

export async function renderCard(input: CardInput): Promise<Buffer> {
	const backdrop = networkSvg({ width: WIDTH, height: HEIGHT, seed: seedFrom(input.seed) });

	// Long titles need to shrink or they wrap to three lines and collide with
	// the description. Two breakpoints is enough for every page we have.
	const titleSize = input.title.length > 34 ? 62 : input.title.length > 22 ? 72 : 82;

	const tree = node(
		'div',
		{
			style: {
				width: WIDTH,
				height: HEIGHT,
				display: 'flex',
				position: 'relative',
				fontFamily: 'Inter',
				backgroundColor: '#04070e',
			},
		},
		[
			// Backdrop.
			node('img', {
				width: WIDTH,
				height: HEIGHT,
				style: { position: 'absolute', top: 0, left: 0 },
				src: `data:image/svg+xml;base64,${Buffer.from(backdrop).toString('base64')}`,
			}),
			// A veil under the text, so the network never fights the words.
			node('div', {
				style: {
					position: 'absolute',
					top: 0,
					left: 0,
					width: WIDTH,
					height: HEIGHT,
					// Opaque out to 74%, where the widest line of text ends, then a
					// fast fade across the bright core of the sphere.
					backgroundImage:
						'linear-gradient(90deg, rgba(4,7,14,0.97) 0%, rgba(4,7,14,0.93) 52%,' +
						' rgba(4,7,14,0.74) 74%, rgba(4,7,14,0) 92%)',
				},
			}),
			// Content.
			node(
				'div',
				{
					style: {
						position: 'relative',
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-between',
						padding: '64px 72px',
						width: WIDTH,
						height: HEIGHT,
					},
				},
				[
					node('div', { style: { display: 'flex', alignItems: 'center', gap: 16 } }, [
						logoMark(),
						node(
							'div',
							{ style: { fontSize: 30, fontWeight: 600, color: INK, letterSpacing: -0.5 } },
							"Cap'n Web",
						),
						...(input.section
							? [
									node('div', { style: { width: 1, height: 26, backgroundColor: '#1e3350' } }),
									node(
										'div',
										{
											style: {
												fontSize: 20,
												fontWeight: 600,
												color: AZURE,
												letterSpacing: 2.2,
												textTransform: 'uppercase',
											},
										},
										input.section,
									),
								]
							: []),
					]),

					node('div', { style: { display: 'flex', flexDirection: 'column', maxWidth: 820 } }, [
						node(
							'div',
							{
								style: {
									fontSize: titleSize,
									fontWeight: 600,
									color: INK,
									lineHeight: 1.08,
									letterSpacing: -1.6,
								},
							},
							input.title,
						),
						...(input.description
							? [
									node(
										'div',
										{
											style: {
												marginTop: 22,
												fontSize: 27,
												fontWeight: 400,
												color: DIM,
												lineHeight: 1.4,
											},
										},
										// Three lines is the budget; a longer description gets cut
										// rather than pushing the rest of the layout around.
										clamp(input.description, 150),
									),
								]
							: []),
					]),

					node('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } }, [
						node('div', { style: { width: 34, height: 3, backgroundColor: ORANGE } }),
						node(
							'div',
							{ style: { fontSize: 21, fontWeight: 400, color: DIM } },
							'github.com/cloudflare/capnweb',
						),
					]),
				],
			),
		],
	);

	const svg = await satori(tree as never, { width: WIDTH, height: HEIGHT, fonts });
	return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng());
}
