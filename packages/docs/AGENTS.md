# The Cap'n Web docs site

Astro, with [Nimbus](https://nimbus-docs.com) (`@cloudflare/nimbus-docs`) as the docs framework. The
package handles content schemas, sidebar/TOC, MDX to markdown, search, OG cards, `llms.txt`, build
hooks, and the `nimbus-docs` CLI. Everything in `src/` is a real file in this repo and yours to
edit, including the files the scaffold wrote.

`README.md` next to this file explains why the site looks and works the way it does: the palette,
the page shell, the WebGL hero, the example playgrounds, the traps. Read it before changing anything
visual.

## Working in here

This package is **excluded from the repo's npm workspaces** and has its own `package-lock.json` and
`node_modules`, so install from this directory:

```sh
cd packages/docs
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in ./dist
npm run check    # astro check: types, content collections
npm run lint:docs
```

If `npm install` 404s on `@cloudflare/nimbus-docs`, your npmrc maps the `@cloudflare` scope to an
internal registry and these packages are on the public one:

```sh
npm_config_@cloudflare:registry=https://registry.npmjs.org npm install
```

Don't commit an `.npmrc` to work around it, and don't add `wrangler` as a dependency here: the
version the starter asks for wants an unpublished miniflare. The root's wrangler deploys this.

`predev` and `prebuild` run `bundle-size` and `playgrounds`. The playground bundler reads the
library's **build output**, so a change under the repo's `src/` needs `npm run build` at the root
before it shows up on an examples page. `npm run dev:docs` at the root does both.

## File layout

Where things are, and what each one is for:

```text
astro.config.ts              # nimbus(defineNimbusConfig({...})): sidebar, lint rules, markdown plugins
nimbus.json                  # what the scaffold and the registry installed. Committed.
.nimbus/                     # build scratch: materialized lint config, route manifest. Gitignored.
fonts/                       # build-time only, for the OG cards. Not under public/ on purpose.
scripts/
├── build-playgrounds.mjs    # bundles each example's worker + client into public/playground/
├── measure-bundle.mjs       # writes src/generated/bundle-size.json
└── mdast-bundle-size.mjs    # Sätteri plugin: %BUNDLE_SIZE% in .md bodies
src/
├── components.ts            # MDX globals registry -- every component used in .mdx must be listed
├── components/              # ours: Hero, Features, NavList, Playground, Prose, and
│                            #       canvas-hero/ (the landing figure and its harness)
│   └── ui/<slug>/           # from the Nimbus registry, plus AgentDirective, Header, Render
├── content/docs/**.{md,mdx} # the pages, one directory per sidebar group
├── content.config.ts        # docsCollection() + partialsCollection() + the %BUNDLE_SIZE% transform
├── examples.ts              # the single list of playground examples, read by pages and bundler
├── generated/               # bundle-size.json, written by prebuild. Gitignored.
├── layouts/                 # BaseLayout (head, theme bootstrap), DocsLayout (three columns)
├── lib/                     # cn.ts, source.ts (reads real files)
├── pages/                   # [...slug].astro, 404, llms.txt, robots.txt, og/
└── styles/                  # globals.css (tokens + shell), prose.css
public/                      # favicon, _headers, and the generated playground bundles
wrangler.jsonc               # static assets on a Worker, no script
```

## Writing docs

Frontmatter validates against Nimbus's `docsSchema`. `title` is required. Sidebar **groups** are
declared in `astro.config.ts`; position **within** a group comes from frontmatter:

```mdx
---
title: My page
description: One-line summary.
sidebar:
  order: 3
---

Content here. The H1 comes from `title` -- don't repeat it in the body.

## Section heading
```

Rules:

- **Components must be PascalCase and registered in `src/components.ts`.** A pre-build validator
  fails the build on an unregistered tag, with a "did you mean" hint.
- **Partials use `<Render file="..." />`.** Don't import `.mdx` directly.
- **Icons are `astro-icon` + Phosphor**: `<Icon name="ph:<glyph>" />`, imported from
  `@cloudflare/nimbus-docs/components/Icon.astro` rather than `astro-icon/components`, which is not
  a dependency here. Glyphs: [phosphoricons.com](https://phosphoricons.com).
- **A `mode: custom` page gets a bare `<main>`** -- no sidebar, no TOC, and no `.docs-content`
  wrapper or width cap either, so its prose must be wrapped in `<Prose>` or it renders unstyled and
  edge to edge.
- **Never type the library's size into prose.** Write `%BUNDLE_SIZE%` and it is substituted from the
  measured value, in bodies and in frontmatter alike.
- **Don't remove `<AgentDirective />` from `BaseLayout.astro`.** It points agents at `/llms.txt`.

House style for the prose itself: no em dashes (` -- ` in text, which the markdown pipeline leaves
alone), every code fence gets a language, and no code block directly under an `##` heading -- say
what it is first.

## Adding things

| Goal                      | Action                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| New doc page              | `src/content/docs/<group>/<slug>.md`, with `sidebar.order`. The group autogenerates.                                   |
| New sidebar group         | A directory under `src/content/docs/` and an `autogenerate` entry in `astro.config.ts`.                                |
| Off-site sidebar link     | Give the group an `items:` array: `{ autogenerate }` first, then `{ label, link }`. Nimbus adds `target="_blank"`.     |
| New partial               | `src/content/partials/<slug>.mdx` (the collection is registered; there are none yet), then `<Render file="<slug>" />`. |
| UI from the registry      | `npx nimbus-docs add <slug>`, then register it in `src/components.ts` if MDX uses it.                                  |
| New playground example    | An entry in `src/examples.ts` (`files` and `build`), and a page under `src/content/docs/examples/`.                    |
| Custom page route         | A file under `src/pages/`.                                                                                             |
| OG card restyle           | `src/pages/og/_og-card-config.ts`.                                                                                     |
| Check it builds           | `npx nimbus-docs check` -- build-free preflight. `--json` for an agent loop, `--fix` to repair what's safe.            |
| Check for updates         | `npx nimbus-docs outdated` -- starter files behind their tag, registry components behind.                              |
| Review an upstream change | `npx nimbus-docs diff <file>`, then `diff --apply <file>`.                                                             |
| Update a registry item    | `npx nimbus-docs add <slug> --overwrite`, then read `git diff`.                                                        |

`npx nimbus-docs list` shows what is installable.

Ten starter files are modified here, so `diff --apply` wants review rather than a blind apply: the
two layouts, `[...slug].astro`, `404.astro`, `components.ts`, `content.config.ts`, `globals.css`,
the OG config, `tsconfig.json`, and `index.mdx`. `README.md` says why for each.

Two registry components are modified too, so `add --overwrite` will silently undo the changes.
`breadcrumbs/Breadcrumbs.astro` and `page-actions/PageActions.astro` shipped their separators as
`text-muted-foreground/50` and `/40`. The alpha modifier is the `opacity` sin by another name -- the
breadcrumb `/` measured 2.19:1 in light -- so the breadcrumb separators inherit
`text-muted-foreground` from the `<ol>` (6.22:1 light) and the page-action divider sits at `/70`,
which is 3.21:1 light and 5.38:1 dark: past the 3:1 line for a graphical object, still visibly
quieter than the buttons it separates.

`PageActions.astro` also pins the "Updated" date to `config.locale` and `timeZone: "UTC"`. It
formatted with an `undefined` locale in the build machine's zone, and this is a static site, so the
string was whatever the builder's environment happened to be: the same commit renders `Aug 11, 2026`
here, `12. Aug. 2026` under `de_DE`/`Asia/Tokyo`, and `2026年8月12日` under `ja_JP`. Note the day
moves too, because the timestamp is a real instant from `git log %at`.

## Audit this site

Start with `npx nimbus-docs check --json`. It runs the environment, structural, authoring, and type
checks build-free -- config validity, `site` placeholder, route collisions, MDX component
resolution, the lint rules, and a `tsc` type-check -- and returns three top-level signals plus
per-scope detail:

- **`status`** (`passed` | `failed` | `partial`) and **`readiness`** (`buildable` | `blocked` |
  `unknown`) are the primary signals. `status` is the whole-run verdict; `readiness` answers "does
  env + structure say it builds?". `ok` (=== zero errors) is kept for back-compat only.
- **`findings[{scope,code,severity,file,line,message,fixable,fix}]`** are problems we evaluated.
  Apply each `fix` (or `check --fix`).
- **`scopes[].notes[{code,reason,requiresBuild?,requiresInput?}]`** are checks we *couldn't*
  evaluate yet (e.g. types before a build). A note is never a finding and never carries a `fix` --
  you resolve it by making the missing thing exist (usually a build), not by `--fix`.
  `summary.notes` counts them.

Loop terminates on `status !== "failed" && summary.fixable === 0` -- a `partial` run with nothing
left to fix is a **stop** (optionally build, then re-check), not a `--fix` retry. Exit is `1` only
when `status` is `"failed"`. For full coverage (types + link-checking) run a build first, then
`check` again.

Only two authoring rules are errors here (`nimbus/frontmatter-shape`, `nimbus/internal-link`); the
rest are off because the repo already lints markdown at the root. Then walk these categories for
what `check` doesn't cover:

- **Config** -- `astro.config.ts` calls `nimbus(defineNimbusConfig({ ... }))`; `site` is set;
  `editPattern` contains `{path}`; `output:` matches the deploy target.
- **Content** -- `content.config.ts` registers `docsCollection()` and `partialsCollection()`; every
  `.mdx` is inside a registered collection; frontmatter validates.
- **Sidebar** -- every group in the config resolves to a directory with pages in it; no orphans; no
  slug collisions.
- **MDX** -- every PascalCase component in `*.mdx` is registered; every `<Render file=...>`
  resolves; code-fence languages are valid.
- **Routes** -- `llms.txt.ts`, `robots.txt.ts`, `[...slug]/index.md.ts`, `og.png.ts`,
  `og/[...slug].ts` all exist.
- **Registry hygiene** -- every `src/components/ui/<slug>/` is either MDX-registered or imported in
  `src/`; transitive deps (`lib/cn.ts`) exist.
- **AI surface** -- `<AgentDirective />` renders in `BaseLayout.astro`; doc `<head>` has
  `<link rel="alternate" type="text/markdown" ...>`.
- **Search** -- `data-pagefind-body` is on the docs main wrapper; after a build, `dist/pagefind/`
  exists with at least one indexed page.
- **Cloudflare** -- `wrangler.jsonc` has `name`, `compatibility_date`,
  `assets.directory = "./dist"`, `not_found_handling`.
- **Dead CSS** -- a selector that matches nothing on any page is usually a rule left pointing at a
  vendor the site no longer uses. That is how the playground's Expressive Code rules were found.

Emit findings as `- [error|warn|info] FILE:LINE -- what + why + fix.` and end with
`Summary: N errors, N warnings.`

## Don't

- Hand-add a component under `src/components/ui/` that the registry already has -- use
  `nimbus-docs add` so its dependencies come with it.
- Import `.mdx` files directly. Use `<Render file="..." />`.
- Attach remark/rehype plugins via `mdx({ remarkPlugins })`: Sätteri silently drops them.
  Markdown transformations go in `markdown.mdastPlugins` / `hastPlugins`, and a Sätteri plugin is a
  visitor over read-only nodes that writes through `context.setProperty`.
- Edit `src/components.ts` to bypass registration. If MDX uses a component, register it.
- Spend the tomato accent (`--cw-orange`, which is also `--nb-primary`) on anything else. It is the
  call to action and almost nothing else -- prose links are ink, not accent -- and that restraint is
  the point. If you do set text in it, use `--cw-orange-text`: the brand tomato is 3.1:1 on the
  paper, and the darkened variant exists so light mode has a legal way to say the same thing.
- Assume the landing page is dark. It was, and is not any more -- it honours the toggle like every
  other page, and the hero figure reads its colours from the same tokens as the prose.
  `.cw-home` marks the page, not a scheme.
- Treat the hero figure as decoration. It is the page's argument, in the flow, at full contrast, so
  its text is type: contrast-measured in both schemes, never dimmed with `globalAlpha`, and carried
  in words by the `sr-only` `<figcaption>` that `CanvasFigure.astro` requires as a prop. Any number
  the scene draws has to match the caption in `lib/hero-copy.ts`, and nothing checks that for you.
- Freeze a reduced-motion still on a moment rather than composing one. A still is the only frame
  some visitors ever see, so it has to carry the whole argument. Watch for fades in particular: the
  figure once froze at the exact instant its slow verdict began fading in, so the number it exists
  to show was painted at `globalAlpha` 0. Pixel and screenshot checks cannot see that -- assert on
  the draw calls, and treat anything drawn at alpha 0 in a still as a bug.
- Size the figure's layout in breakpoints. Its margins are budgeted from the measured width of the
  strings that go in them, which is why shortening one label narrowed the whole middle of the
  figure. A width threshold cannot see what is beside a rail: the first cut used one and ran the
  call labels straight through an axis tick at 900px.
- Judge the figure by its painted percentage. `painted > 0` says nothing about whether the thing
  drew what it meant to. Check the scene's own draw calls.
- Dim text with `opacity` to make it secondary. `--nb-muted-foreground` is already that, measured;
  multiplying it by 0.6 is how the figure captions ended up the least readable text on the site.
  Tailwind's alpha modifier is the same sin with better manners: `text-muted-foreground/50` is not a
  colour choice, it is 2.19:1.
- Set the wordmark as live `<text>`, or hand-edit `logo-paths.ts`. It is generated by
  `scripts/build-wordmark.mjs`; change the tilt, size, tracking or jitter there and regenerate. A
  logo that falls back to Georgia is not the logo.
- Swap the wordmark's face to URW Bookman because it is already installed and is what the
  reference uses. It is AGPL-3 and its font exception covers only Postscript and PDF, not SVG.
  TeX Gyre Bonum Bold is the same Bookman design under the GUST Font License.
- Merge the wordmark's per-glyph paths into one path per line. The fill then floods their union
  and swallows the keyline wherever two letters touch.
- Theme the mark or the seal. Both are fixed in both schemes -- white fill with a black keyline,
  and tomato with `--cw-black` lettering at 5.69:1 -- because they are stamped objects rather than
  page furniture.
- Take the seal's invisible `background` off `.cw-star-text`. It is the same tomato it sits on, and
  it exists so contrast tools measure the real pair instead of walking past the SVG to the page.
- Regularise the wordmark's per-glyph jitter. The `rot`/`dy`/`scale` arrays are measured off the
  reference, not decoration: a hand-set mark is what is being parodied, and zeroing them makes it
  visibly deader.
- Soften the hero banner's bottom edge. It ends on a hard line because a cereal box is printed
  rather than blended, and the seal crossing that line is what stops the band reading as a floating
  slab. Nothing from the banner down may set `overflow: hidden`.
- Lighten the light-mode banner again. It is at its ceiling: the white mark averages 5.07:1 across
  the band and is at exactly 4.50:1 over the brightest corner, so there is no headroom left. A pale
  band means a black-filled mark, which is a different logo.
- Lower `.cw-hero-lockup`'s `max-width` to shrink the mark on a phone. That is the `min(100%, cap)`
  branch that is not taken there; the band's inline padding is what sets the size below 48rem.
- Straighten the mark's left nudge because the artwork looks centred without it. The nudge offsets
  the seal's visual weight, which hangs off the right and is not in the mark's box at all.
- Resize either line of the lockup without re-checking the clearance the build prints. `LEAD` is a
  multiple of the lower line's cap height, so changing `size` moves the leading with it, and the
  reference's range is 17-34px.
- "Restore" the hero seal's overhang to the reference's 19%. It is 28.2% on purpose: the band was
  tightened under the mark after that measurement, and against a shorter band 19% reads as resting
  on the edge rather than crossing it. One coefficient in the seal's `top` sets it.
- Tilt the seal as a whole. `--cw-star-tilt` belongs on `.cw-star-shape` so the legend stays level
  and `.cw-star`'s layout box stays measurable; rotating the wrapper inflates its bounding box by
  17% and every harness then has to divide that back out.
- Replace `--cw-hero-nudge`'s clamp with a constant. The nudge only fits where the lockup has hit
  its cap and left slack beside it; a fixed value walks the mark off the left edge of a phone.
- Point the favicon at the hero's 20-point star. It is a separate 11-point star at a deeper 0.55
  ratio because the seal's own geometry turns into a fuzzy disc at tab size, and its fill is a
  literal hex -- a favicon is its own document and inherits no custom properties.
- Reach for `--cw-mark-fill` / `--cw-mark-stroke` to recolour the wordmark. They exist so the
  header can drop to a one-colour silhouette at 40px, where the keyline is a third of a pixel and
  renders as haze. A differently coloured stamp is a different decision; make it deliberately.
- Try to size `Wordmark.astro` or `StarBadge.astro` from a parent's scoped CSS. Astro stamps a
  child's root element with the *child's* scope hash, so the rule silently matches nothing. Size
  the wrapper the parent owns and let the svg fill it. Custom properties do inherit through.
- Remove `.cw-hero-lede` or `.cw-hero-actions` because nothing styles them. They are measurement
  hooks for the hero's vertical rhythm, which is a claim `/tmp/opencode/vgaps.mjs` checks.
- Remove `<AgentDirective />` unless asked.
