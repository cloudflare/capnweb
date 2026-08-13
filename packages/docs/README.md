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

| Component           | Role                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| `Hero.astro`        | The landing page's headline, tagline and calls to action, over the stage.           |
| `NetworkHero.astro` | The stage behind the hero, edge to edge.                                            |
| `LightTunnel.astro` | React Bits' LightTunnel, ported to vanilla JS + ogl, with `light-tunnel.client.ts`. |
| `HeroExample.astro` | The paired client/server sample floating in the hero.                               |
| `Features.astro`    | The landing page's bento figures.                                                   |
| `NavList.astro`     | The landing page's link lists, built from `examples.ts` and a literal.              |
| `Playground.astro`  | The examples' source-and-demo stage.                                                |
| `Prose.astro`       | The prose container a `mode: custom` page has to bring itself.                      |

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

### Two families of token

Nimbus's own tokens are `--nb-*`, and Tailwind utilities like `bg-card` and `border-border` are
generated from them in the `@theme` block. Ours are `--cw-*`: the raw palette, plus the handful of
values the page shell needs that have no Nimbus equivalent.

| Token             | Dark      | Light     | Used for                                  |
| ----------------- | --------- | --------- | ----------------------------------------- |
| `--cw-ground`     | `#090c10` | `#e2e7ec` | the ground the page sheet rests on        |
| `--nb-background` | `#0c1014` | `#eef1f4` | the content sheet and the desktop sidebar |
| `--nb-primary`    | `#e85d2c` | `#e85d2c` | primary actions                           |
| `--cw-orange`     | `#e85d2c` | `#e85d2c` | the CTA spark                             |

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
WebGL hero below and dropped it from docs pages entirely, which is why those pages now idle at 0.0%
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

The landing page is outside all of that. It is a fixed dark design, so the bootstrap resolves `/` to
dark whatever is stored, `BaseLayout` puts `.cw-home` on the body, and `globals.css` hides the theme
toggle there rather than leaving a control that does nothing. The toggle still themes every docs
page, and a choice made on one is honoured when the reader leaves the landing page.

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
hero's shader every texture is a gradient.

## The homepage hero

The landing page hero (`src/components/NetworkHero.astro`) mounts a vanilla port of React Bits'
LightTunnel (`src/components/LightTunnel.astro` + `light-tunnel.client.ts`). It is WebGL2 via `ogl`,
paused when off-screen or when the tab is hidden, its device pixel ratio capped at 2, and skipped
entirely under `prefers-reduced-motion`. It is also the only expensive thing the site ships: the
landing page loads 62.7 kB of JavaScript (20.8 kB gzipped) against a docs page's 20.9 kB (9.4 kB),
nearly all of it `ogl`. That is the trade -- one page pays for the first impression, no other page
pays anything. Docs pages get nothing behind them at all: the content sheet is the page.

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
