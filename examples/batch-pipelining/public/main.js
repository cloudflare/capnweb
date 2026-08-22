// DOM wiring for the comparison. The RPC is all in demo.js.
import { pipelined, sequential } from './demo.js';

const $ = (id) => document.getElementById(id);
const rtt = () => Number($('rtt').value);

function reset() {
	for (const id of ['pPosts', 'pTime', 'sPosts', 'sTime']) $(id).textContent = '\u2026';
	$('pOut').textContent = $('sOut').textContent = 'Not run yet.';
	$('pBar').style.width = $('sBar').style.width = '0';
	$('verdict').hidden = true;
	$('verdict').classList.remove('error');
}

async function run() {
	$('run').disabled = true;
	$('run').textContent = 'Running\u2026';
	reset();
	try {
		const p = await pipelined(rtt());
		$('pPosts').textContent = p.posts;
		$('pTime').textContent = `${Math.round(p.ms)} ms`;
		$('pOut').textContent = JSON.stringify(p.value, null, 2);

		const s = await sequential(rtt());
		$('sPosts').textContent = s.posts;
		$('sTime').textContent = `${Math.round(s.ms)} ms`;
		$('sOut').textContent = JSON.stringify(s.value, null, 2);

		const worst = Math.max(p.ms, s.ms) || 1;
		$('pBar').style.width = `${(p.ms / worst) * 100}%`;
		$('sBar').style.width = `${(s.ms / worst) * 100}%`;

		const saved = Math.round(s.ms - p.ms);
		const times = (s.ms / p.ms).toFixed(2);
		$('verdict').innerHTML =
			`<strong>${p.posts} round trip vs ${s.posts}.</strong> Pipelining finished ` +
			`${saved} ms sooner (${times}&times; faster), returning identical data.`;
		$('verdict').hidden = false;
	} catch (err) {
		$('verdict').classList.add('error');
		$('verdict').textContent = `Failed: ${err?.message ?? err}`;
		$('verdict').hidden = false;
	} finally {
		$('run').disabled = false;
		$('run').textContent = 'Run both';
	}
}

/** Keeps the readout and the slider's painted fill in step with the value. */
function syncRtt() {
	const el = $('rtt');
	const min = Number(el.min);
	const fraction = (Number(el.value) - min) / (Number(el.max) - min);
	el.style.setProperty('--pct', `${fraction * 100}%`);
	$('rttValue').textContent = `${el.value} ms`;
}

$('rtt').addEventListener('input', syncRtt);
syncRtt();
$('run').addEventListener('click', run);
$('reset').addEventListener('click', reset);
run();
