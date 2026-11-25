/**
 * Maps repository-relative Markdown paths to site routes. Shared by the Astro
 * link rewriter and the docs/skill pages so every surface agrees on where
 * `doc/**.md` and the agent skill live.
 */
export const DOCS_BASE = "/docs";
export const SKILL_ROUTE = "/skill/";
export const SKILL_REPO_PATH = "skills/titan-mk/SKILL.md";

/** `doc/how-to/x.md` -> `/docs/how-to/x/`; `doc/index.md` -> `/docs/`; skill -> `/skill/`. */
export function docsRouteForRepoPath(repoRel, fragment = "") {
  if (repoRel === SKILL_REPO_PATH) return `${SKILL_ROUTE}${fragment}`;
  if (repoRel.startsWith("doc/") && repoRel.endsWith(".md")) {
    const slug = repoRel.slice("doc/".length, -".md".length);
    return slug === "index" ? `${DOCS_BASE}/${fragment}` : `${DOCS_BASE}/${slug}/${fragment}`;
  }
  return null;
}
