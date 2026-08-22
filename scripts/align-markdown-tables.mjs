/**
 * Pads every Markdown table in the repository so its pipes line up.
 *
 * markdownlint's MD060 can tell you a table is ragged but cannot repair it, and
 * its own `--fix` leaves the delimiter row at its original width while
 * shrinking the data rows, which is worse than either extreme. This does the
 * padding properly: every cell in a column is widened to the column's widest
 * cell, and the delimiter row is rebuilt to the same width with its alignment
 * colons preserved.
 *
 * Usage:
 *   node scripts/align-markdown-tables.mjs            # rewrite in place
 *   node scripts/align-markdown-tables.mjs --check    # exit 1 if any file would change
 *
 * Only tables in prose are touched. Anything inside a fenced code block is left
 * exactly as written, because a table in a code block is a code sample.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CHECK_ONLY = argv.includes('--check');

/**
 * Split a table row into cells on unescaped pipes that are not inside an inline
 * code span. Cap'n Web's tables contain both `\|` and things like `` `a|b` ``,
 * and splitting naively on `|` corrupts them.
 */
function splitCells(line) {
	const cells = [];
	let cell = '';
	let inCode = false;
	let tickRun = 0;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];

		if (ch === '\\' && i + 1 < line.length) {
			cell += ch + line[i + 1];
			i++;
			continue;
		}

		if (ch === '`') {
			// Count the run so ``a`b`` style spans open and close symmetrically.
			let run = 0;
			while (line[i + run] === '`') run++;
			if (!inCode) {
				inCode = true;
				tickRun = run;
			} else if (run === tickRun) {
				inCode = false;
				tickRun = 0;
			}
			cell += '`'.repeat(run);
			i += run - 1;
			continue;
		}

		if (ch === '|' && !inCode) {
			cells.push(cell);
			cell = '';
			continue;
		}

		cell += ch;
	}
	cells.push(cell);

	// A row written `| a | b |` yields empty strings at both ends. Drop them,
	// since they are the outer pipes rather than real cells.
	if (cells.length > 1 && cells[0].trim() === '') cells.shift();
	if (cells.length > 1 && cells.at(-1).trim() === '') cells.pop();

	return cells.map((c) => c.trim());
}

/** A delimiter row: every cell is dashes with optional leading/trailing colon. */
function isDelimiterRow(line) {
	const cells = splitCells(line);
	return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function alignmentOf(cell) {
	const left = cell.startsWith(':');
	const right = cell.endsWith(':');
	if (left && right) return 'center';
	if (right) return 'right';
	if (left) return 'left';
	return 'none';
}

function buildDelimiter(width, alignment) {
	switch (alignment) {
		case 'center':
			return ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
		case 'right':
			return '-'.repeat(Math.max(1, width - 1)) + ':';
		case 'left':
			return ':' + '-'.repeat(Math.max(1, width - 1));
		default:
			return '-'.repeat(Math.max(3, width));
	}
}

/** Rewrite one table, given its header row, delimiter row and body rows. */
function formatTable(rows, delimiterIndex) {
	const cellRows = rows.map(splitCells);
	const columns = Math.max(...cellRows.map((r) => r.length));

	const alignments = cellRows[delimiterIndex].map(alignmentOf);
	while (alignments.length < columns) alignments.push('none');

	const widths = [];
	for (let c = 0; c < columns; c++) {
		let width = 3; // a delimiter needs `---` at minimum
		for (const [index, cells] of cellRows.entries()) {
			if (index === delimiterIndex) continue;
			width = Math.max(width, (cells[c] ?? '').length);
		}
		// Centre and right alignment spend two and one character on colons.
		if (alignments[c] === 'center') width = Math.max(width, 5);
		widths.push(width);
	}

	return cellRows.map((cells, index) => {
		const out = [];
		for (let c = 0; c < columns; c++) {
			if (index === delimiterIndex) {
				out.push(buildDelimiter(widths[c], alignments[c]));
				continue;
			}
			const text = cells[c] ?? '';
			const pad = ' '.repeat(widths[c] - text.length);
			out.push(alignments[c] === 'right' ? pad + text : text + pad);
		}
		return `| ${out.join(' | ')} |`;
	});
}

function alignTables(source) {
	const lines = source.split('\n');
	const out = [];
	let fence = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Track fenced code blocks and copy them through untouched.
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			if (fence && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
				fence = null;
			} else if (!fence) {
				fence = fenceMatch[1];
			}
			out.push(line);
			continue;
		}
		if (fence) {
			out.push(line);
			continue;
		}

		// A table is a run of lines starting with `|`, with a delimiter row second.
		if (line.trimStart().startsWith('|') && isDelimiterRow(lines[i + 1] ?? '')) {
			const rows = [];
			let j = i;
			while (j < lines.length && lines[j].trimStart().startsWith('|')) {
				rows.push(lines[j]);
				j++;
			}
			out.push(...formatTable(rows, 1));
			i = j - 1;
			continue;
		}

		out.push(line);
	}

	return out.join('\n');
}

const { stdout } = await run('git', ['ls-files', '*.md']);
const files = stdout
	.split('\n')
	.filter(Boolean)
	.filter((f) => !/(^|\/)CHANGELOG\.md$/.test(f) && !f.startsWith('.changeset/'));

const changed = [];
for (const file of files) {
	const before = await readFile(file, 'utf8');
	const after = alignTables(before);
	if (before === after) continue;
	changed.push(file);
	if (!CHECK_ONLY) await writeFile(file, after);
}

if (CHECK_ONLY && changed.length > 0) {
	console.error('Tables are not aligned in:');
	for (const file of changed) console.error(`  ${file}`);
	console.error('\nRun: node scripts/align-markdown-tables.mjs');
	exit(1);
}

console.log(
	changed.length === 0
		? `${files.length} files checked, all tables already aligned`
		: `${changed.length} of ${files.length} files realigned`
);
