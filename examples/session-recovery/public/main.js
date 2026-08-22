// DOM wiring for the session-recovery demo. The RPC lives in `session.js`;
// this file only moves its output onto the page.

import { RecoveringClient } from './session.js';

const $ = (id) => document.getElementById(id);

const els = {
  state: $('state'),
  cursor: $('cursor'),
  feed: $('feed'),
  log: $('log'),
  connect: $('connect'),
  sever: $('sever'),
  probe: $('probe'),
  disconnect: $('disconnect'),
  resume: $('resume'),
};

/** Events the page has seen, so a gap in the sequence is visible. */
let seen = [];

function renderFeed() {
  els.feed.replaceChildren(
    ...seen.slice(-14).map((entry) => {
      const li = document.createElement('li');
      li.className = entry.gap ? 'event event--gap' : 'event';
      li.innerHTML = entry.gap
        ? `<span class="event__id">gap</span><span class="event__text">${entry.missed} event${
            entry.missed === 1 ? '' : 's'
          } never arrived</span>`
        : `<span class="event__id">#${entry.id}</span><span class="event__text"></span>`;
      if (!entry.gap) li.querySelector('.event__text').textContent = entry.text;
      return li;
    }),
  );
  els.feed.scrollTop = els.feed.scrollHeight;
}

function report(message, tone = 'plain') {
  const li = document.createElement('li');
  li.className = `line line--${tone}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<span class="line__time">${time}</span><span class="line__text"></span>`;
  li.querySelector('.line__text').textContent = message;
  els.log.append(li);
  while (els.log.children.length > 40) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

/**
 * Record an event, inserting a marker when the sequence jumps.
 *
 * This is what makes the demo worth looking at: without a resume token the
 * numbers skip, and the marker says how many were lost.
 */
function pushEvent(event) {
  const previous = seen.filter((entry) => !entry.gap).at(-1);
  if (previous && event.id > previous.id + 1) {
    seen.push({ gap: true, missed: event.id - previous.id - 1 });
  }
  seen.push(event);
  renderFeed();
}

const client = new RecoveringClient({
  // Same-origin, so this works under `wrangler dev` and in the docs playground
  // without either of them knowing anything about the other.
  url: new URL('/ws', location.href).href.replace(/^http/, 'ws'),
  token: 'demo-token',
  report,
  onEvent: pushEvent,
  onStateChange: (state) => {
    els.state.textContent = state;
    els.state.dataset.state = state;
    els.connect.disabled = state !== 'offline';
    els.sever.disabled = state !== 'online';
    els.disconnect.disabled = state !== 'online';
    els.cursor.textContent = client.cursor === null ? '--' : `#${client.cursor}`;
  },
});

els.connect.addEventListener('click', () => client.connect({ resume: els.resume.checked }));
els.sever.addEventListener('click', () => client.sever());
els.disconnect.addEventListener('click', () => client.disconnect());
els.probe.addEventListener('click', async () => report(await client.probeStaleStub(), 'plain'));

// Keep the cursor readout live while events stream in.
setInterval(() => {
  els.cursor.textContent = client.cursor === null ? '--' : `#${client.cursor}`;
}, 250);

report('idle -- press Connect', 'plain');
