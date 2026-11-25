# mk.titan-lang.dev

Source for [mk.titan-lang.dev](https://mk.titan-lang.dev): the `titan-mk` manual (built from `../doc/`), the agent skill (`../skills/titan-mk/SKILL.md`), and the changelog. It uses the [`@titan-lang/cassini`](https://github.com/mascarenhas/titan-lang-dev/tree/main/packages/cassini) theme and components from titan-lang.dev, and is deployed to the assets-only Cloudflare Worker `titan-mk`.

## Prerequisites

Node.js `>=22.23.4` with `npm`.

## Build

Run from this directory:

```sh
node scripts/fetch-sources.mjs   # must run before the first `npm ci`
npm ci
npm run build                    # Astro site + Pagefind index, into dist/
npm run verify                   # brand contrast, links/fragments/assets, Cloudflare limits
npm run dev                      # local preview with live reload
```

`fetch-sources.mjs` uses only Node built-ins. It downloads the commit tarballs pinned in `sources.json` (Cassini, the Titan TextMate grammar, and the Titan crest) into the gitignored `.generated/cache/`. It also copies Cassini's web fonts into `public/fonts/` and stages `../doc/` and the skill into `.generated/docs/`. `package.json` installs Cassini from `file:.generated/cassini`, so `npm ci` fails until the script has run. Every build re-stages the docs, so edits to `../doc/` show up on the next `npm run build` or `npm run dev`.

To build against local checkouts instead of the pins:

```sh
CASSINI_LOCAL_DIR=~/Code/titan-lang-dev \
VSCODE_TITAN_LOCAL_DIR=~/Code/vscode-titan \
TITAN_LOCAL_DIR=~/Code/titan \
npm run build
```

Cassini and Titan are copied from the working tree. To read a commit instead, set `CASSINI_LOCAL_REF` or `TITAN_LOCAL_REF`. vscode-titan is always read with `git archive` (default `origin/main`; override with `VSCODE_TITAN_LOCAL_REF`). If you change Cassini's dependencies, run `npm install` to refresh `package-lock.json`.

## How the manual is assembled

- The sidebar and reading order come from the `## Part … — …` tables in `../doc/index.md`. A page only appears in navigation if it is listed in one of those tables; `verify-site` fails on unlisted pages.
- Links between Markdown files become site routes: `doc/x/y.md` → `/docs/x/y/`, `doc/index.md` → `/docs/`, `skills/titan-mk/SKILL.md` → `/skill/`. Other repository paths (`src/…`, `Makefile`, `LICENSE`) link to GitHub at `sources.json` `mk.ref`. The mapping lives in `src/routes.mjs`.
- Mermaid code fences render to SVG at build time. `$…$` math is not typeset.
- `src/styles/brand.css` overrides only Cassini's seven `--brand-*` tokens. `npm run verify:contrast` enforces that, and also checks WCAG contrast in both themes.

## Releasing

1. Bump `mk.version` (and `mk.titanVersion` if Titan changed) in `sources.json`, and add the release to `src/content/site/changelog.md`.
2. If the install commands changed, update `src/content/site/install.json`.
3. Open a PR. Same-repo PRs get a Cloudflare preview URL as a comment. Merging to `master` deploys to production.

## Deployment

`.github/workflows/site.yml` builds and verifies every PR and every push to `master` that touches `site/`, `doc/`, or the skill. Same-repo PRs upload a preview version with `wrangler versions upload --preview-alias pr-<N>`. Pushes to `master`, and manual runs on `master`, run `wrangler deploy`. Both use the repository secret `CF_API_TOKEN` and the variable `CF_ACCOUNT_ID`.

`wrangler.jsonc` deliberately omits `routes`, which preserves the dashboard-managed Custom Domain `mk.titan-lang.dev`. It also sets `workers_dev: false` and `preview_urls: true`. A preview upload reads the Worker's Preview URLs setting but does not change it. So before the first PR that needs a preview, either deploy once from `master` or enable **Preview URLs** in the Cloudflare dashboard.
