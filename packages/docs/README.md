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
| `src/layouts/DocsLayout.astro`    | Mounts the node field, and marks `<main>` as the content sheet.                             |
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

| Component             | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `Hero.astro`          | The landing page's headline, tagline and calls to action, over the field. |
| `NetworkHero.astro`   | The field as the hero's own backdrop, edge to edge.                       |
| `GraphBackdrop.astro` | The field behind every other page, mounted by `DocsLayout`.               |
| `Constellation.astro` | The field itself: the markup and the CSS that moves it.                   |
| `Playground.astro`    | The examples' source-and-demo stage.                                      |
| `Prose.astro`         | The prose container a `mode: custom` page has to bring itself.            |

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

`src/styles/globals.css` is the file to edit. The palette is a near-black with a blue undertone
(never a neutral grey) carrying a deep saturated blue as its structural colour and an electric azure
for anything interactive.

Cloudflare orange appears in exactly three places, and the restraint is the point: a fourth use and
it stops meaning anything.

1. the pulses travelling the hero network
2. the primary call to action
3. the marker on the current sidebar page

Note that `--nb-primary`, which colours links and hover states, is the azure and not the orange. The
one orange button is set in `Hero.astro`.

Light mode is a genuine second scheme rather than an inversion: a cool near-white with the same two
accents, darkened to hold contrast on paper. Unlike the Starlight build, the chrome is **not**
near-black in both schemes; a dark rail against a white document read as a screenshot of two
different sites, so light mode has light chrome a shade off its own ground.

### Two families of token

Nimbus's own tokens are `--nb-*`, and Tailwind utilities like `bg-card` and `border-border` are
generated from them in the `@theme` block. Ours are `--cw-*`: the raw palette, plus the handful of
values the page shell and the node field need that have no Nimbus equivalent.

| Token             | Dark      | Light     | Used for                           |
| ----------------- | --------- | --------- | ---------------------------------- |
| `--cw-ground`     | `#04070e` | `#e6edf6` | the ground the page sheet rests on |
| `--nb-background` | `#070b16` | `#ffffff` | the content sheet itself           |
| `--cw-chrome`     | `#05080f` | `#dfe8f4` | the desktop sidebar rail           |
| `--nb-primary`    | `#38a5f5` | `#0a5292` | links, hover, focus                |
| `--cw-orange`     | `#f6821f` | `#f6821f` | the three sparks above             |

The palette is kept as hex rather than converted to oklch, which the scaffold's own comment
recommends. These are measured, tuned values carried over from the theme this replaced, and a round
trip through another colour space would move them for no gain.

### The page is a sheet on a ground

Four layers, and the order matters because the node field has to be visible through the layout
without being visible through the text:

1. `body` paints `--cw-ground`. `BaseLayout` deliberately leaves `bg-background` off it.
2. `body::before` adds two fixed radial washes, so the ground is a space rather than a flat fill.
3. The node field is fixed at `z-index: -1`: above the body's own background, below every element.
4. `<main data-cw-sheet>` paints `--nb-background`, with a hairline, a radius and a shadow above
   `64rem`. The sidebar rail is opaque chrome; the table-of-contents rail is left transparent.

So the field shows through the right-hand rail and the margins, which are the parts of the page meant
to be looked through rather than at, and, blurred, through the masthead, which is a translucent
`bg-card` over a `backdrop-blur`. The TOC rail is transparent and the nav rail is not because the nav
is dense enough that a field crossing its labels costs legibility, and legibility wins.

The landing page is the exception: it paints its own field edge to edge behind the hero, so the
ground wash is suppressed under it and the ground is set to the field's own outer colour, which
means the veil finishes fading onto the same value rather than stepping onto a different one.

### Which scheme loads

The mode attribute is `data-mode` on `<html>`, present as `"dark"` and **absent** in light. The
stored choice is `ui-mode` in `localStorage`.

The bootstrap in `BaseLayout.astro` queries `(prefers-color-scheme: light)` rather than `dark`, on
purpose: the site was designed dark, so a reader whose OS expresses no preference gets dark. A stored
choice still wins over the OS.

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

The site self-hosts Inter and JetBrains Mono through `@fontsource-variable`, imported in
`BaseLayout.astro`. A first visit fetches 86.6 kB of font (47.1 kB Inter, 39.5 kB JetBrains Mono,
latin subsets only, then cached for a year by `public/_headers`).

This is a change from the Starlight build, which used the system stack and shipped no fonts at all.
It is a deliberate keep: the type is then identical on every OS, and the heading scale in
`globals.css` was tuned against it. If it ever needs reverting, it is the two imports and the two
`--nb-font-*` tokens, and the site will want a fresh visual review afterwards.

There are no raster images anywhere in the site's own chrome. The only other textures are gradients.

## The node field

Two surfaces show a constellation of nodes and edges: the landing page hero
(`src/components/NetworkHero.astro`) and a backdrop behind every other page
(`src/components/GraphBackdrop.astro`, mounted in `DocsLayout` for every page that is not
`mode: custom`, since a custom page paints its own and two would fight). Both render
`src/components/Constellation.astro`, whose geometry is computed at build time by
`src/lib/constellation.ts` from a fixed seed, so the field is identical on every build and screenshot
diffs stay meaningful.

This was a 2D canvas and a WebGL2 field, each driven by a `requestAnimationFrame` loop. They looked
better than what replaced them and they cost a CPU core to look at, which is not a trade a
documentation site should make. There is now no script at all: the markup is static and the motion
is CSS.

**Only `transform` and `opacity` on HTML elements are animated.** That is the whole design
constraint, because those are the two properties the compositor can animate without waking the main
thread. Measured on this site, idling for eight seconds:

| Technique                        | Main thread |
| -------------------------------- | ----------- |
| `transform` on HTML elements     | 0.1%        |
| `opacity` on HTML elements       | 0.0%        |
| `opacity` on SVG children        | 0.6%        |
| `stroke-dashoffset` on SVG lines | 3.6%        |

That table is why edges are rotated `<div>`s rather than SVG `<line>`s, which would otherwise be
the obvious choice. A message travelling along a connection is then a child element sliding with
`translateX`, which is free; as an animated dash it cost several percent of a core on its own.

The result is about 1% of a core on a docs page and a little over that on the landing page, and
**exactly 0%** under `prefers-reduced-motion`, where the field is still drawn and simply stops
moving.

### Keeping the lines attached to the dots

Three separate things have to hold, and two of them were got wrong first time round.

**The scale has to be uniform.** `Constellation.astro`'s stage has a fixed `aspect-ratio` and is
sized to cover its container, so the mapping from authored coordinates to pixels is a single scale
factor and an angle baked in at build time is still correct at every window size and zoom level.
Percentages alone would not survive a resize: they resolve against width and height separately, so
a rotated edge would drift off its endpoints as the window changed shape.

**Everything has to move together.** There used to be three parallax groups drifting at three
speeds, and 76% of the edges joined nodes that were in two different groups, so most of the field
was being pulled apart and back together over the drift cycle. It is not a tuning problem: an edge
is one element, pinned at one end and rotated, so it can only stay attached at both ends if both
ends share a transform. Since the field is one connected graph, that means the whole field is one
transform group, and parallax is simply not available. Depth is carried by radius and brightness,
which is where most of it was coming from anyway.

**The graph has to be connected.** `buildField` guarantees a single connected component. The greedy
nearest-neighbour pass that gives the field its look caps edge length and node degree, and both
caps can strand a node; a second pass runs Kruskal over the same sorted pair list and adds back
whatever is needed to join the pieces, ignoring both caps. `Constellation.astro` asserts the result
and fails the build otherwise, because a dot sitting on its own is the kind of flaw a reader
notices, cannot explain, and no screenshot diff will catch.

`scripts/` has no test for this; the check lives in `Constellation.astro` and runs on every build.
The rendered-geometry check that caught the parallax bug measured, for every edge at ten viewport
sizes and six zoom levels, whether both of its endpoints landed on a dot. Worth rebuilding if this
area is touched again: the failure is invisible in code review and obvious on screen.

### There is no hover response

The old field lit up the node nearest the pointer and sent a pulse out and back along each of its
edges. It has not been reimplemented, and it cannot be in CSS alone.

It was built and measured before being removed: invisible hit circles per node, `pointer-events:
auto` against a `pointer-events: none` parent, and a generated `:has()` rule per node. It works and
it is unreachable. The field is painted behind the page, and CSS hit-testing cannot express
"receive the pointer only where nothing is drawn over me" -- the topmost box wins whether or not it
painted anything. On a docs page the content panel spans nearly the whole viewport, leaving the
backdrop as the topmost hit target on **1.3%** of it. Putting the hit layer above the content
restores the hover and costs the page its text selection and some of its links.

Restoring the behaviour means a `pointermove` listener that finds the nearest node and sets one
class. That is not a render loop, and the animation would stay on the compositor, but it is script.

## Social cards

Every page gets its own Open Graph image at `/og/<slug>.png`, generated at build time by
`astro-og-canvas` through the routes the scaffold provides. The card's whole visual definition is
`src/pages/og/_og-card-config.ts`: the site's dark scheme, and a 12px orange border on the leading
edge, which is the one thing that makes one of these recognisable at thumbnail size.

There used to be a hand-written pipeline here: a seeded SVG rendering of the same node field, laid
out with Satori and rasterized with resvg, plus a subset of Inter and a script to build it. It came
to about seven hundred lines to produce a nicer picture than the framework's, and it was deleted
during the port. The framework's cards are worse and are one config object, and social cards are not
where this site earns anything.

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
