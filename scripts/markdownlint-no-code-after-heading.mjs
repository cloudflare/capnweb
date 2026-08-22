/**
 * A custom markdownlint rule: a heading must not be followed immediately by a
 * fenced or indented code block.
 *
 * Two reasons, one visual and one about the reader. Visually, headings on the
 * documentation site carry a bottom rule, and a code frame butted against that
 * rule produces two horizontal lines a few pixels apart with nothing between
 * them. For the reader, a heading names a topic; it does not say what the
 * sample below it demonstrates, what to look at in it, or why it is there.
 * Arriving at a wall of code with no orientation is a small unkindness that
 * repeats on every page.
 *
 * The fix is usually already written. When a code block opens a section, the
 * paragraph that explains it is very often sitting directly underneath, and
 * moving it above the block is the whole edit. Where no such paragraph exists,
 * a sentence naming what the sample shows has to be written.
 *
 * Configurable via `levels`, an array of heading depths to enforce. The default
 * is `[2]`: section headings, which are the ones with the rule under them.
 */

/** Heading depth from the run of `#` characters micromark recorded. */
function atxLevel(headingToken) {
	const sequence = headingToken.children?.find((child) => child.type === 'atxHeadingSequence');
	if (!sequence) return 0;
	return sequence.endColumn - sequence.startColumn;
}

/** Tokens that carry no content and so do not separate a heading from a block. */
const INSIGNIFICANT = new Set(['lineEnding', 'lineEndingBlank', 'linePrefix', 'lineSuffix']);

const CODE_BLOCK = new Set(['codeFenced', 'codeIndented']);
const HEADING = new Set(['atxHeading', 'setextHeading']);

export default {
	names: ['CW001', 'no-code-block-after-heading'],
	description: 'Heading should be followed by prose, not immediately by a code block',
	tags: ['headings', 'code'],
	parser: 'micromark',
	function: (params, onError) => {
		const levels = new Set(params.config.levels ?? [2]);

		// Only top-level tokens matter. A code block nested inside a list item or
		// a blockquote is not what this rule is about.
		const tokens = params.parsers.micromark.tokens.filter(
			(token) => !INSIGNIFICANT.has(token.type)
		);

		for (const [index, token] of tokens.entries()) {
			if (!CODE_BLOCK.has(token.type)) continue;

			const previous = tokens[index - 1];
			if (!previous || !HEADING.has(previous.type)) continue;

			// A setext heading has no `#` run to measure, so it is always in scope.
			if (previous.type === 'atxHeading' && !levels.has(atxLevel(previous))) continue;

			onError({
				lineNumber: token.startLine,
				detail:
					'Introduce the sample first. The paragraph that explains it is often the ' +
					'one directly below the block, and moving it up is the whole fix.',
				context: params.lines[previous.startLine - 1]?.trim(),
			});
		}
	},
};
