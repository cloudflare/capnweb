# capnweb-docs

The documentation website for Cap'n Web, built with [Astro](https://astro.build/) and
[Nimbus](https://nimbus-docs.com) (`@cloudflare/nimbus-docs`), Cloudflare's docs framework.

It was a Starlight site until the port that `git log` on this directory records. Nimbus is a
different proposition: rather than a theme with override slots, it scaffolds the layouts, routes and
components **into the repo** as ordinary files. Nothing here is behind a plugin boundary, which is
why this file can explain the whole site, and why upgrading is a review rather than a version bump.

`AGENTS.md` next to this file is the operating manual: the commands, the file tree, the authoring
rules. This file is why the site is the way it is.

## Running it

This package is **deliberately excluded from the repo's npm workspaces** (see `!packages/docs` in the
root `package.json`). The docs site pulls in Astro, Vite and a few hundred transitive dependencies,
and we don't want any of that hoisted into the tree that builds and tests the library itself. It
therefore has its own `package-lock.json` and its own `node_modules`.

```sh
cd packages/docs
npm install

npm run dev      # dev server at http://localhost:4321
npm run build    # static output in ./dist
npm run preview  # serve ./dist
npm run check    # astro check (types + content collections)
```

`dev` and `build` are both preceded by `npm run playgrounds`, which bundles the examples into
`public/playground/`. That step reads the library's **build output**, so run `npm run build` at the
repo root first, or just use `npm run dev:docs` there, which does both.

The examples no longer need to be running for the docs to work: their demos are bundled into the
pages. To run one as a real Worker over a real network, see `examples/README.md`.

Two things about installing, both of which have cost time:

**The `@cloudflare` scope may not resolve.** `@cloudflare/nimbus-docs` is on the public registry. A
machine whose npmrc maps that scope to an internal registry gets a 404 on install; override it for
the one command rather than committing an `.npmrc`:

```sh
npm_config_@cloudflare:registry=https://registry.npmjs.org npm install
```

**Wrangler is not a dependency here.** The starter lists one, at a version that resolves to an
unpublished alpha of miniflare. The root's wrangler deploys this site, so the dependency is simply
absent; `npm run deploy` in this package picks up the root's, which npm puts on the path (4.63.0).

## What Nimbus owns, and what we changed

Nimbus provides the content schemas, the sidebar and table of contents, the markdown pipeline, the
search index, the OG-card routes, the `llms.txt` family of routes, and the `nimbus-docs` CLI. What it
does **not** do is own the layouts: `src/layouts`, `src/pages`, `src/components/ui` and
`src/styles` are files the scaffold wrote into this repo and we have been editing ever since.

That is a real trade. There is no `starlight.config` to read to find out what the page does, and no
upstream fix arrives on its own. In exchange, every question about this site has an answer in this
directory, and the framework cannot be blamed for anything visible.

The CLI tracks which of those files came from the scaffold and at what version:

```sh
npx nimbus-docs outdated        # starter files behind their tag, registry components behind
npx nimbus-docs diff <file>     # what upstream changed vs what we changed
npx nimbus-docs check           # build-free preflight: env, structure, authoring, types
```

Ten scaffold files are modified, so an upgrade to any of them is a merge and not an apply:

| File                              | Why it diverges                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/styles/globals.css`          | The theme: palette, tokens, page shell, code chrome. Most of the port lives here.           |
| `src/layouts/BaseLayout.astro`    | The theme bootstrap: `is:inline`, dark as the no-preference answer, `data-theme` published. |
| `src/layouts/DocsLayout.astro`    | Marks `<main>` as the content sheet.                                                        |
| `src/pages/[...slug].astro`       | Serves the root index entry at `/` rather than `/index`.                                    |
| `src/pages/404.astro`             | `id="main-content"` on `<main>`, without which the skip link goes nowhere.                  |
| `src/components.ts`               | Registers our three components as MDX globals.                                              |
| `src/content.config.ts`           | The `%BUNDLE_SIZE%` frontmatter transform.                                                  |
| `src/pages/og/_og-card-config.ts` | Card palette, and the font moved out of `public/`.                                          |
| `tsconfig.json`                   | Excludes the generated playground bundles; no deprecated `baseUrl`.                         |
| `src/content/docs/index.mdx`      | It is our landing page.                                                                     |

Three of those are fixes to the starter rather than customisations, and should go upstream: the
404's missing skip-link target, the theme bootstrap emitting a deferred `<script type="module">`
(measured at about sixty frames of light flash under 20x CPU throttling), and `baseUrl`, which `tsc`
now errors on and `astro check` does not notice.

`nimbus.json` records what the scaffold and the registry installed and is committed. `.nimbus/` is
build scratch and is not.

Everything else under `src/components/` is either ours (below) or a registry component installed with
`nimbus-docs add`, which is why they are not hand-written: `add` brings a component's dependencies
with it.

Ours, and the reason each exists:

| Component            | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `Hero.astro`         | The landing page's headline, tagline and calls to action, over the stage. |
| `CanvasFigure.astro` | The hero's animated comparison, with the harness in `canvas-hero/`.       |
| `Features.astro`     | The landing page's bento figures.                                         |
| `NavList.astro`      | The landing page's link lists, built from `examples.ts` and a literal.    |
| `Playground.astro`   | The examples' source-and-demo stage.                                      |
| `Prose.astro`        | The prose container a `mode: custom` page has to bring itself.            |

Only `Hero`, `Playground` and `Prose` are registered as MDX globals; the other three are imported by
`index.mdx` directly, which is the other way a component can reach an MDX page.

`Prose` looks like ceremony and is not. `mode: custom` gives a page a bare `<main>`: no sidebar, no
table of contents, and no `.docs-content` wrapper or width cap either. Every prose rule in
`styles/prose.css` is scoped to `.docs-content`, so a custom page without `<Prose>` renders its body
text unstyled and edge to edge.

### The machine-readable surface

Nimbus emits a second, plain-text copy of the site, which Starlight did not: `/llms.txt` as an index,
`/llms-full.txt` and a per-section `/<section>/llms.txt`, and a markdown twin of every page at
`/<slug>/index.md` (also `.mdx`), linked from each page's `<head>` and from the "View as Markdown"
action under its title. `<AgentDirective />` in `BaseLayout` points a crawler at the index.

The thing to remember is that these routes derive their paths from the entry id, and the markdown
twins already special-case the root index so it lands at `/index.md` rather than `/index/index.md`.
`[...slug].astro` has to agree with them in two places, the route and the `markdownUrl` it advertises,
or the home page links at a 404. Leave `<AgentDirective />` where it is.

## Where the content comes from

**This site is the source of truth for user-facing documentation.** It began as a migration of the
repo's root `README.md` and `protocol.md`; the root README has since been trimmed to a landing page
that links here, and `protocol.md` is gone; `reference/protocol` replaced it.

If you change behaviour, update the page here. Two files still hold prose of their own and should be
kept in sync by hand:

| Source                                | Pages that mirror it                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Root `README.md`                      | `start/introduction`, `start/installation` (the intro bullets and the install snippet appear in both) |
| `packages/capnweb-validate/README.md` | `guides/validation`                                                                                   |

One number is never typed: `%BUNDLE_SIZE%` is substituted from `src/generated/bundle-size.json`,
which `scripts/measure-bundle.mjs` writes during prebuild by measuring the built library. It is
reached three ways, because there are three places a token can appear and only one pipeline sees each:
a Sätteri plugin for `.md` bodies, a schema `transform` for frontmatter, and a plain JSON import in
`index.mdx`, which interpolates it directly. `scripts/mdast-bundle-size.mjs` explains why the third
exists.

## The theme

`src/styles/globals.css` is the file to edit. The palette is a soft cool grey (`#eef1f4`) with slate
ink and a restrained tomato CTA. Type is DM Sans for headings, body and UI, and Commit Mono for
code.

Light mode is a genuine second scheme rather than an inversion. The sidebar and the content sheet
share `--nb-background`: one surface, not a darker rail meeting a lighter document.

Both schemes are held to WCAG AA at their real sizes, measured on the surface each thing actually
sits on rather than on the one it nominally belongs to. That distinction is what most of the
failures turned out to be: `--nb-muted-foreground` cleared AA on the sheet and missed it on the
ground, and the ground is what shows through the table-of-contents rail and the masthead. The audit
harness walks every text node on a page, resolves the effective background through however many
translucent ancestors it has, and reports anything under 4.5:1 (3:1 for large text). It currently
reports one hit in each scheme, and that hit is the hero title, whose colour is `transparent`
because the gradient is clipped to the glyphs.

The harness reads colours by painting them into a 1x1 canvas rather than by matching `rgb(...)`.
That is not fussiness: `color-mix()` and Tailwind's `/40` alpha modifier make
`getComputedStyle().color` come back as `color(srgb ...)` or `oklab(...)`, and a regex parser
silently *skips* what it cannot read, so the nodes most likely to be too faint are exactly the ones
that vanish from the report. Switching to canvas surfaced 41 more per scheme on the first run. It
also scopes to WCAG's own definition of text and reports anything inside an `aria-hidden` subtree
separately, since decoration is held to 3:1 as a graphical object, not 4.5:1 as prose.

### Two families of token

Nimbus's own tokens are `--nb-*`, and Tailwind utilities like `bg-card` and `border-border` are
generated from them in the `@theme` block. Ours are `--cw-*`: the raw palette, plus the handful of
values the page shell needs that have no Nimbus equivalent.

| Token              | Dark      | Light     | Used for                                  |
| ------------------ | --------- | --------- | ----------------------------------------- |
| `--cw-ground`      | `#090c10` | `#e2e7ec` | the ground the page sheet rests on        |
| `--nb-background`  | `#0c1014` | `#eef1f4` | the content sheet and the desktop sidebar |
| `--nb-primary`     | `#e85d2c` | `#e85d2c` | primary actions                           |
| `--cw-orange`      | `#e85d2c` | `#e85d2c` | the CTA spark                             |
| `--cw-orange-text` | `#e85d2c` | `#b03f18` | the same spark, when it is text           |

Two of those need saying out loud, because both are places where the obvious value is the wrong one:

- **The label on a tomato button is ink, not white.** White on `#e85d2c` is 3.5:1, and it gets
  *worse* on hover as the fill brightens, to 2.8:1. Ink is 4.6:1 and gets better, to 5.7:1.
  cloudflare.com resolves the identical problem the identical way: its orange buttons carry
  near-black labels.
- **Orange as text is not the same orange as orange as a fill.** The brand tomato is 3.1:1 on the
  paper, so anything set in it at body size is below AA before it starts. `--cw-orange-text` is the
  same hue darkened to 5.2:1, and in dark mode it is just the brand colour, which needs no help
  there. Nothing sets body text in it today; it exists so that the next thing to try cannot quietly
  use the 3.1:1 one.

The palette is kept as hex rather than converted to oklch, which the scaffold's own comment
recommends. These are measured, tuned values carried over from the theme this replaced, and a round
trip through another colour space would move them for no gain.

### The page is a sheet on a ground

Three layers, so that the reading column reads as a panel resting on something rather than as the
page itself:

1. `body` paints `--cw-ground`, a shade off the sheet. `BaseLayout` deliberately leaves
   `bg-background` off it.
2. `body::before` adds two fixed radial washes at `z-index: -2`, so the ground is a space rather
   than a flat fill.
3. `<main data-cw-sheet>` paints `--nb-background`. The sidebar uses Nimbus's own `bg-background`
   and a single `border-r`; the table-of-contents rail is left transparent.

So the washed ground shows through the right-hand rail and the page margins, and, blurred, through
the masthead, which is `bg-background/80` over a `backdrop-blur`. The current page in the sidebar is
Nimbus's own `bg-accent` highlight, not a second indicator painted on top of it.

There used to be a fourth layer between the washes and the sheet: a CSS constellation of nodes and
edges, fixed at `z-index: -1`, drawn behind every page. The landing redesign replaced it with the
hero's own stage and dropped it from docs pages entirely, which is why those pages now idle at 0.0%
of a core. `git log -- src/lib/constellation.ts` has the whole thing if it is ever wanted back.

The landing page is the exception to the layering: it paints its own dark stage edge to edge behind
the hero, so `body:has(.cw-hero-field)` suppresses the wash and sets the body to `--nb-background`,
which is exactly where the stage's veil finishes fading, so the seam below the hero lands on a single
value.

### Which scheme loads

The mode attribute is `data-mode` on `<html>`, present as `"dark"` and **absent** in light. The
stored choice is `ui-mode` in `localStorage`.

The bootstrap in `BaseLayout.astro` queries `(prefers-color-scheme: light)` rather than `dark`, on
purpose: the site was designed dark, so a reader whose OS expresses no preference gets dark. A stored
choice still wins over the OS.

The landing page used to be outside all of that: it was a fixed dark design, the bootstrap resolved
`/` to dark whatever was stored, and the toggle was hidden there because it would have done nothing.
It is no longer exempt. `.cw-home` remains on the body, but it now marks the page rather than its
scheme, and the two rules that still key off it are about the hero, not about being dark.

The two `theme-color` metas are media-scoped, so a first visit gets browser chrome that matches the
OS before any script runs. A stored choice that disagrees with the OS is reconciled by the bootstrap,
which drops the media condition from whichever one won.

It also publishes `data-theme="light" | "dark"`, which nothing in Nimbus reads. The example
playgrounds do: they are same-origin iframes that read the embedding page's theme before their first
paint, and an attribute that is absent half the time cannot be read positively by a document that
may load either way round. `Playground.astro`'s own light override keys off the same attribute.

That script must keep its `is:inline`. Without a directive Astro processes it into a deferred
`<script type="module">`, the document paints before it runs, and a reader whose stored choice is
dark gets a flash of the light scheme first.

With JavaScript off the page renders light, which is accepted: the alternative is a dark default in
CSS and a flash of dark for light-mode readers, which is the more common case and the more jarring
direction.

### Type

The site self-hosts DM Sans (variable) and Commit Mono through `@fontsource`, imported in
`BaseLayout.astro`: 83.1 kB on a first visit, latin subsets only, then cached for a year by
`public/_headers`.

DM Sans (`--nb-font-sans`) carries body, UI and headings; Commit Mono (`--nb-font-mono`) is code.
There is a `--nb-font-display` token for headings, but it currently aliases `--nb-font-sans`: a
separate display face (Cal Sans) was tried and dropped, and the token was left in place as the seam
to reintroduce one. Following the Kumo design skill (kumo-ui.com/skill), headings are set at the
font's natural tracking rather than letter-spaced (`--nb-h*-tracking: normal`), sizes are a small set
of deliberate steps, and nothing in the chrome is uppercased.

This is a change from the Starlight build, which used the system stack and shipped no fonts at all.
It is a deliberate keep: the type is then identical on every OS, and the heading scale in
`globals.css` was tuned against it. If it ever needs reverting, it is the imports and the
`--nb-font-*` tokens, and the site will want a fresh visual review afterwards.

There are no raster images anywhere in the site's own chrome: the favicon is SVG, and apart from the
hero's canvas figure every texture is a gradient.

## The homepage hero

The hero is a headline, a tagline, an animated figure and two buttons, in that order, over a stage
that is pure CSS. `Hero.astro` owns all of it. There is no canvas behind the copy and no WebGL
anywhere on the site.

The stage is a wide radial pool of `--cw-hero-stage-bg` over the page background, taller than the
hero so it runs on behind the first band of prose rather than ending in a seam, with a veil over it
that dissolves the edges back into the page and harder at the bottom. `globals.css` suppresses the
page's own top decoration for any page containing `.cw-hero-field`, so the two never stack.

The order matters and is a prop. `illustration="below"` puts the copy first; the default puts it
after. The landing used to lead with a pair of code windows and treat the headline as their caption,
which works because a static block of code is taken in at a glance. An animation is not: it has a
running time, and opening on one asks the reader to work out what they are watching before being
told why.

### The figure is content, not decoration

`CanvasFigure.astro` mounts the `versus` scene in the flow, at full contrast, with nothing over it.
It draws two sequence diagrams on one shared 0-440ms axis: on the left four dependent calls awaited
one at a time, each paying for its own round trip and its own visit to the far end, and on the right
the same four pipelined into one trip, with the 300ms nobody spends shaded in.

The far end takes 10ms per call, on both sides, and drawing that mattered more than its size
suggests. With an instant server the picture put the entire cost of the chain on the network, which
flattered the pipelined column: it read as though the work had gone away. It has not. The same 40ms
of handler runs in both columns -- four separate visits on the left, back to back on the right --
and what pipelining removes is only the waiting in between. Ten milliseconds is seven pixels of a
306px axis, so the scene draws the handler as a solid cap on the server rail; seven pixels of plain
nothing between an arriving line and a departing one reads as a rendering fault rather than as time
passing.

Three rules follow from it being content rather than texture, and all three are the opposite of what
a backdrop wants.

- **The text is type, so it is measured like type.** The verdicts carry the numbers the docs use --
  four dependent calls costing four round trips and 440ms against one round trip and 140ms -- set in
  `--nb-foreground` and `--nb-muted-foreground` at 11-14px with **no `globalAlpha` dimming at all**.
  The first pass did dim them, and `fig-contrast.mjs` caught four label classes at 3.48-4.36:1 in
  light: the `opacity`-as-hierarchy sin, committed against text already chosen for its contrast.
  Everything now clears 4.5:1 in both schemes. Remaining alpha in the scene is on strokes and fills,
  where the 3:1 rule applies.
- **A canvas needs words.** The figure is a `<figure>` with an `sr-only` `<figcaption>`, and
  `CanvasFigure` requires the caption as a prop. The text lives in `lib/hero-copy.ts` beside the
  headline, because the numbers in it are the numbers the scene draws and nothing checks that they
  still agree. A canvas is an empty element to a screen reader, and the DOM contrast harness cannot
  see into one either, which is why the hero title reports `rgba(0,0,0,0)`.
- **The reduced-motion still has to carry the whole argument**, not a representative moment. It
  freezes mid-hold rather than at the instant the last reply lands, because the verdicts fade in
  over 25ms of story time: frozen at `TOTAL_MS` exactly, the slow lane's "4 round trips" was painted
  at
  `globalAlpha` 0 and the still lost the one number it exists to show. No screenshot diff would
  catch that, so `still-text.mjs` asserts on draw calls -- both verdicts visible at every width, the
  saved band wherever it fits, and nothing painted at alpha 0.

One wire label, at the far end: `batched request`. There was a second one, `pipeline`, against the
client rail the pushes leave from, and it was saying what the column header, the four converging
lines and the verdict underneath already said. The arrival is the half of the claim that is not
obvious from the picture -- that one thing crossed and the far end had everything it needed -- so
that is the half that gets words. Dropping it is not a contradiction of "1 round trip" either: a
pipelined batch really is four `push` messages in one body, and what there is only one of is the
trip.

The scene's clock is in milliseconds of story, and used to be in "legs", where a leg was one
crossing and everything else was a fraction of one. That was fine while the far end answered
instantly and stopped being fine the moment it did not: 10ms is a fifth of a leg, and a model that
can only count crossings cannot place it. `yAt` is now the only thing that knows how tall a
millisecond is.

### Laying it out

The time axis stands **between** the two diagrams rather than to the left of both. That is not where
a y-axis normally goes, and it is the point: this axis is not either panel's scale, it is the single
shared clock that makes the two readable against each other. It also fixes the composition, because
an axis on the left is the outermost ink on the figure with nothing answering it on the right, and
no amount of centring the panels among themselves corrects for an element that exists on one side
only. The ticks cross the line rather than stopping at it, for the same reason.

That choice deleted more arithmetic than it added. There is no panel box: each diagram is placed
`AXIS_HALF` from the axis and `RAIL_HALF * 2` wide, so the pair is a mirror about the centre at
every width and the outer margins come out equal without being computed. Measured skew between them
is 0px from 360 to 1920. Two earlier attempts at balance -- tiling the width into panels and pulling
them together, then mirroring the axis column as right-hand margin -- were both corrections for a
layout that was asymmetric by construction, and both went away with it.

Detail sheds in the order that keeps the argument last: the method names go below 900px, the axis
and the "300 ms saved" band below 600px, and both verdicts survive to 360px. What is shown is
decided from measured label budgets, not width breakpoints -- the first cut keyed off `panelW < 240`
and ran the call labels straight through the `200` tick at 900px.

Sizes are derived from the strings, so they move when the copy does, and `AXIS_HALF` is the one that
keeps proving it. It was 104 while the fast panel's client rail read "one message", 88 when that was
shortened to "pipeline", and 56 now the label is gone and the binding constraint is the other side
of the column: the slow panel's "server" rail label with the tick numbers reaching back towards it.
That last step took another 64px of dead space out of the middle of the figure. It is computed from
those two measurements rather than typed, because all three of the earlier values were numbers
somebody measured once and then left behind.

### The harness

`canvas-hero.client.ts` owns everything that is not drawing: the device pixel ratio, capped at 2 so
a 3x phone does not rasterize nine times the pixels for no visible gain; an accumulated clock, so
parking the loop pauses the story instead of fast-forwarding it; `Resize`- and
`IntersectionObserver`; `visibilitychange`; and a `MutationObserver` on `data-theme` that repaints
even while parked, so a scheme flip is never stale. It repaints once more when the webfonts land,
because canvas text is rasterized at draw time with no reflow behind it, so a frame painted before
the swap keeps its fallback font for as long as it is on screen -- and under reduced motion that is
one frame, forever.

It also refuses to mount twice on a container it has already claimed. The figure once shipped drawn
twice, one copy over the other, which is invisible on an opaque scene and obvious the moment
anything is translucent.

Unlike the WebGL hero it replaced, reduced motion still gets a canvas here, holding one composed
frame. A still diagram is not a motion problem, and an empty hero is worse.

### What used to be here

This hero was picked by building fourteen of them. Routes `/1` to `/9` were the landing page with a
different animation each, judged side by side and then deleted: thirteen scenes, a shared node
field, a lane stage, a text-fitting helper, a scene registry, and the `KeepOut` system that measured
the hero's real content boxes so a backdrop could lay itself out in the clear space beside the copy.
`git log` has all of it. None of it survives, because a foreground figure in its own box has nothing
to avoid, and the one scene left ignored every coordinate that machinery produced.

The WebGL hero went the same way. `NetworkHero.astro`, `LightTunnel.astro` and
`light-tunnel.client.ts` were a vanilla port of React Bits' LightTunnel drawn twice by one shader,
once emissive for the dark stage and once as ink so it could dissolve into a light page instead of
sitting in a hard-edged dark band. It was also the only expensive thing the site shipped: 56.4 kB of
`ogl`, on the page that gets the most first-time traffic. Once the figure moved to the foreground it
was a second animation competing with the thing the page is actually arguing, and `Hero.astro`'s
static import kept pulling it into the bundle even after nothing rendered it. The dependency is
gone.

The result is a landing page that ships **19.0 kB of JavaScript uncompressed**, 7.1 kB of which is
the figure and its harness, against 62.7 kB before.

### The bento figures

`Features.astro` draws the bento figures as SVG line art in `--cw-art-stroke`, at a dozen different
stroke opacities, which is a technique that assumes a dark stage: a 0.13-alpha stroke over near-black
is a visible hairline, and the same stroke over `#eef1f4` is nothing. Measured per figure, the light
scheme was running at 1.12--1.76:1 mean contrast, and the globe -- whose wires were hardcoded blues
rather than tokens -- peaked at **1.37:1**, which is invisible. Every opacity went up, the base
stroke went from 1 to 1.15, the globe's colours became `--cw-art-stroke-rgb`, and the light stroke
deepened to `#253c6d`. That puts the figures at 1.26--2.17:1 mean and 4.98--9.64:1 peak. Mean stays
low on purpose: these are line drawings on a large empty field, so most of the box is background and
what matters is the contrast of the strokes themselves.

## Social cards

Every page gets its own Open Graph image at `/og/<slug>.png`, generated at build time by
`astro-og-canvas` through the routes the scaffold provides. The card's whole visual definition is
`src/pages/og/_og-card-config.ts`: the site's dark scheme, and a 12px tomato border on the leading
edge, which is the one thing that makes one of these recognisable at thumbnail size. The cards are
still set in Inter, which the site itself no longer uses -- they are rasterized, so the face is a
build input rather than something a reader downloads.

There used to be a hand-written pipeline here: a seeded SVG rendering of the node field the site had
at the time, laid out with Satori and rasterized with resvg, plus a subset of Inter and a script to
build it. It came to about seven hundred lines to produce a nicer picture than the framework's, and
it was deleted during the port. The framework's cards are worse and are one config object, and
social cards are not where this site earns anything.

Two things worth knowing:

**The font is build-time only, and is deliberately not in `public/`.** `astro-og-canvas` resolves
font paths from the project root when it rasterizes, so `fonts/Inter-Bold.ttf` works and is never
served. Left where the starter puts it, that is 420 kB copied into `dist/` and deployed for no
reader. The rendered cards are byte-identical either way.

**Absolute URLs come from `site`.** Open Graph needs an absolute `og:image`. `astro.config.ts`
defaults `site` to the preview deployment so the tags are valid today; set `DOCS_SITE_URL` once a
canonical domain exists.

## The example playgrounds

The `/examples/*` pages are laid out like a code playground: the real source on the left, the demo
running on the right, filling most of the viewport. `src/examples.ts` is the single list of
examples, read by both the pages and the bundler.

### Nothing is running on a server

There is no backend. `scripts/build-playgrounds.mjs` bundles each example's **own Worker** into the
page beside its **own client**, and installs a `fetch` shim that hands requests for the RPC path
straight to the Worker's `fetch` handler:

```js
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).pathname === RPC_PATH) {
    return await worker.fetch(request, ENV, ctx);
  }
  return upstream(input, init);
};
```

Everything above that line is the genuine code path: the same session setup, the same batch
encoding, the same `newWorkersRpcResponse` answering. So the round-trip counts the demos print are
real, and the whole site still deploys as static assets. `newWorkersRpcResponse` is safe to run in a
browser because its POST branch is just the HTTP batch path; only the WebSocket-upgrade branch
touches `WebSocketPair`, and the shim never routes an upgrade to it.

Output lands in `public/playground/<slug>/` and is gitignored. `predev` and `prebuild` regenerate
it, so it cannot go stale, but note it bundles the library's **build output**, so a change to
`src/` needs `npm run build` at the repo root before it reaches a playground.

The iframe points at `/playground/<slug>/index.html`, spelled out in full. Astro's dev server does
not resolve a directory request under `public/` to its index, so the tidier-looking
`/playground/<slug>/` is a 404 in dev even though most static hosts, including Cloudflare's asset
handling, would serve it. The path is derived from the slug in `examples.ts` so it cannot drift
from where the bundler writes.

Worth knowing when verifying this: **a production build served by any ordinary static file server
will hide that class of bug**, because directory-index resolution is a property of the host. Check
`astro dev` too.

Details worth keeping:

- **The Worker's `env` is read from the example's `wrangler.jsonc` `vars`**, so the playground runs
  with the same delays as a real deployment rather than a second copy of those numbers drifting
  over here. That is the only reason there is a JSONC parser in the script.
- **`capnweb-validate` codegen runs during bundling.** `@validateRpc()` is a build-time transform;
  bundle without the plugin and the example silently loses the validation it is demonstrating. The
  React playground's "Test validation failure" button is the check that it did run.
- **Specifiers are resolved by an `onResolve` hook, not the examples' tsconfig `paths`**, which
  point at `.d.ts` files that esbuild would try to bundle.
- **One copy of the library per page.** `capnweb` is marked external and rewritten to a sibling
  `vendor/capnweb.js` that the client and the Worker share.

### The source panes

**The code is read from the real files at build time.** `src/lib/source.ts` reads each path from the
repo, so the source on the site cannot drift from the code that ships. A moved or renamed file is a
build error, not a silently empty tab; that is the whole point, so please keep it that way rather
than catching the error.

**Whole files only.** There is no mechanism for showing an excerpt, and that is deliberate: an
excerpt is a claim that the rest does not matter, and the reader has no way to check it. Line
numbers drift silently the moment anything above them changes, and named regions turn out to be a
way of leaving a file badly organised while making its docs tab look tidy.

So when a file is too long or too mixed to show, the fix is to split the file. Each example keeps
its RPC code in a module of its own (`demo.js`, `runs.ts`, `session.js`) with the DOM wiring
somewhere else. That is better code regardless of the docs, which is the point.

Finding the repo root is done by walking up to sentinel files rather than counting `..` segments,
because for a production build this code is bundled into `dist/.prerender/chunks/` and any fixed
offset silently breaks.

### Layout and theme

The stage needs the full width of the main column but prose does not, so the component widens
`--nb-content-max` to `100%` and caps everything that is *not* the stage at `47rem`. That keeps
left edges aligned with the page title, and avoids trying to break a centred column out past a
sidebar whose width would have to be guessed at. Below `60rem` the two panes stack, demo first.

Both of those rules are guarded by `:root:has(.capn-stage)`, and the guard is load-bearing rather
than decorative: `is:global` styles are hoisted into the route's shared stylesheet, so every page
built by `[...slug].astro` loads them. Unguarded, the prose cap applied to the landing page.

Because the demo is served from this same site it is **same-origin**, which buys two things: the
iframe `src` is server-rendered (so the code is still readable with JavaScript off) and the embedded
page reads the docs theme straight off `parent.document` before first paint, so there is no flash
and no theme in the URL. Later toggles are pushed over `postMessage`, so the frame never reloads.
Each demo applies the result with `color-scheme`, which is why they use `light-dark()` rather than a
`prefers-color-scheme` media query, and each hides its own header when embedded.

The stage's own chrome deliberately does **not** use the site palette. It is meant to read as an
editor, so `Playground.astro` defines a small local palette. `--pg-bg` is the editor body: the stage
paints it and the code block inside is stripped back to transparent, so the active tab and the code
below it are the same fill by construction, which is what makes the tab strip look attached rather
than stuck on top. The tab strip and the preview toolbar are both `2.25rem` so the two panes line up.

Stripping that code block back is four rules against Nimbus's `.nb-code-figure`, and getting them
wrong is not a cosmetic failure. The figure has to become the pane's flex column, and the `<pre>`
inside it has to be the element that scrolls; as it comes out of the framework the figure clips the
file at the pane's height and the rest of it is unreachable, which is how the port shipped for a
while. The language badge is suppressed in here too: the tab above already names the file.

The demos keep their own visual identity (the React one is Cloudflare orange) on purpose. The
toolbar above the frame is the boundary; making them look like docs widgets would undercut the point
that these are real apps. What they should *not* keep is their own page chrome: the React app's 5px
brand stripe is `display: none` under `[data-embedded]`, alongside its `h1`, because framed it just
reads as a stray line under the toolbar.

Per-file explanations are `title` tooltips on the tabs rather than a visible strip of prose, which
keeps the pane looking like an editor. The text still lives in `examples.ts`.

`public/playground` is excluded in `tsconfig.json`; without that, `astro check` type-checks the
bundled vendor output and reports ~200 hints from it.

### Adding an example

An entry in `src/examples.ts` (both the `files` list and the `build` block) and a page under
`src/content/docs/examples/`. The sidebar picks it up from the directory; `sidebar.order` in the
page's frontmatter decides where in the group it lands.

## Traps worth knowing about

**The markdown pipeline is not remark.** Nimbus compiles markdown with Sätteri, whose plugins are
visitor objects keyed by node type, over read-only nodes, writing through `context.setProperty`.
Passing remark plugins to `mdx({ remarkPlugins })` does not error; they are silently dropped. Also
note that a Sätteri plugin cannot mutate `attributes` on an `mdxJsxFlowElement`: the op stream has
no encoding for it and the write throws. An MDX page can import and interpolate instead, which is
what `index.mdx` does.

**A PascalCase tag in MDX must be registered.** `src/components.ts` is the registry, a pre-build
validator reads it, and an unregistered tag fails the build with a "did you mean" hint. This is a
good failure mode and worth knowing before it looks like a resolution bug.

**`getDocsStaticPaths` uses the entry id verbatim**, so `docs/index.mdx` would be served at
`/index`. `[...slug].astro` maps that one id to the root, as Nimbus's own site does, and the
markdown twin route needs the same mapping or the home page's "view as markdown" link 404s.

**Icons come from Nimbus, not `astro-icon`.** The registry's `link-card` imports
`astro-icon/components`, which is not a dependency of `nimbus-docs` or of the starter.
`@cloudflare/nimbus-docs/components/Icon.astro` is a documented drop-in and accepts `is:inline`.

**A selector that matches nothing is a bug you cannot see.** The playground's source pane kept
styling Expressive Code for a while after Nimbus replaced it with Shiki: the rules parsed, applied to
nothing, and the pane looked plausible from the top while everything below the first screen of each
file was unreachable, which on the longest example was 4,600 pixels of source. Sweeping every rule in
every stylesheet against every page and reporting the ones that never match found it in one pass, and
is worth repeating after any framework change.

## Deployment

`npm run build` emits a plain static site to `dist/`, deployable anywhere. `site` defaults to the
preview deployment so that canonical URLs, Open Graph URLs, the sitemap and the links inside
`/llms.txt` are all valid; point it at a real domain with `DOCS_SITE_URL`:

```sh
DOCS_SITE_URL=https://example.com npm run build
```

`wrangler.jsonc` deploys that output to a Cloudflare Worker. There is no `main`, so no Worker script
runs: every request is served from the asset store, which is all a static site with in-browser
playgrounds needs.

```sh
npm run deploy   # rebuilds first, via predeploy
```

`public/_headers` is part of the deployment rather than decoration. Workers' default for static
assets is `must-revalidate`, and a response that must be revalidated cannot be served from cache, so
the page Astro had already prefetched on hover was thrown away and refetched on the click. The
stylesheet, revalidated but answered with a 304, arrived first, and that gap was a frame of styled
header over bare background between navigations. The file gives documents a minute of freshness and
fingerprinted assets a year.

Pick the account with `CLOUDFLARE_ACCOUNT_ID` if your token can see more than one. Note that an
account may put Cloudflare Access in front of its whole `*.workers.dev` subdomain, in which case the
deployed URL prompts for SSO until a bypass policy is added for the hostname.
