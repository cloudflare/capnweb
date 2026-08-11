# The Cap'n Web docs site

Astro, with [Nimbus](https://nimbus-docs.com) (`@cloudflare/nimbus-docs`) as the docs framework. The
package handles content schemas, sidebar/TOC, MDX to markdown, search, OG cards, `llms.txt`, build
hooks, and the `nimbus-docs` CLI. Everything in `src/` is a real file in this repo and yours to
edit, including the files the scaffold wrote.

`README.md` next to this file explains why the site looks and works the way it does: the palette,
the node field, the example playgrounds, the traps. Read it before changing anything visual.

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
├── components/              # ours: Hero, NetworkHero, Constellation, GraphBackdrop, Playground, Prose
│   └── ui/<slug>/           # from the Nimbus registry, plus AgentDirective, Header, Render
├── content/docs/**.{md,mdx} # the pages, one directory per sidebar group
├── content.config.ts        # docsCollection() + partialsCollection() + the %BUNDLE_SIZE% transform
├── examples.ts              # the single list of playground examples, read by pages and bundler
├── generated/               # bundle-size.json, written by prebuild. Gitignored.
├── layouts/                 # BaseLayout (head, theme bootstrap), DocsLayout (three columns)
├── lib/                     # cn.ts, constellation.ts (node field geometry), source.ts (reads real files)
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
- Add a fourth use of Cloudflare orange. It appears in three places and the restraint is the point.
- Remove `<AgentDirective />` unless asked.
