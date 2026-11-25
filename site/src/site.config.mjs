import fs from "node:fs";
import path from "node:path";
import { parseBookToc } from "@titan-lang/cassini/nav";
import { DOCS_BASE, SKILL_REPO_PATH, SKILL_ROUTE } from "./routes.mjs";

const ROOT = process.cwd();
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));

const DOCS_DIR = path.join(ROOT, ".generated/docs/doc");
const SKILL_PATH = path.join(ROOT, ".generated/docs", SKILL_REPO_PATH);
export const GRAMMAR_PATH = path.join(
  ROOT,
  ".generated/sources/vscode-titan/syntaxes/titan.tmLanguage.json",
);

const REPO_URL = `https://github.com/${SOURCES.mk.repo}`;
const VERSION = SOURCES.mk.version;

export const MANUAL_TITLE = "titan-mk Manual";

export const SITE = {
  brandName: "titan-mk",
  projectLabel: "titan-mk Web Framework",
  title: "titan-mk — HTTP/1.1 Web Framework for Titan",
  description:
    "An HTTP/1.1 web framework written in Titan with compiled PEG routing, typed JSON body binding, structured logging, ten built-in middleware modules, and shared-nothing OS worker threads.",
  logoSrc: "/assets/titan-logo.svg",
  version: VERSION,
  // The rockspec requires `titan ~> 0.6`; sources.json `mk.titanVersion` is the release it is tested on.
  titanSeries: SOURCES.mk.titanVersion.split(".").slice(0, 2).join("."),
  versionBadge: `v${VERSION}`,
  siteUrl: "https://mk.titan-lang.dev/",
  siteLabel: "mk.titan-lang.dev",
  licenseUrl: `${REPO_URL}/blob/${SOURCES.mk.ref}/LICENSE`,
  searchPlaceholder: "Search the titan-mk manual and skill...",
  githubUrl: REPO_URL,
  // `?plain=1`: GitHub's Markdown source view (the rendered page duplicates /skill/).
  skillSourceUrl: `${REPO_URL}/blob/${SOURCES.mk.ref}/${SKILL_REPO_PATH}?plain=1`,
  navLinks: [
    { label: "Docs", href: `${DOCS_BASE}/`, matchPrefix: `${DOCS_BASE}/` },
    { label: "Agent Skill", href: SKILL_ROUTE, matchPrefix: SKILL_ROUTE },
    { label: "Changelog", href: "/changelog/", matchPrefix: "/changelog/" },
  ],
};

/** Props shared by every BaseLayout/DocsLayout instance. */
export const LAYOUT_PROPS = {
  brandName: SITE.brandName,
  projectLabel: SITE.projectLabel,
  logoSrc: SITE.logoSrc,
  versionBadge: SITE.versionBadge,
  navLinks: SITE.navLinks,
  githubUrl: SITE.githubUrl,
  siteUrl: SITE.siteUrl,
  siteLabel: SITE.siteLabel,
  licenseUrl: SITE.licenseUrl,
  searchPlaceholder: SITE.searchPlaceholder,
};

let cachedToc = null;

/**
 * Parses `doc/index.md` (`## Part … — …` tables) into the manual's parts,
 * sidebar, and reading order, with the agent skill appended as a final group.
 */
export function getManualToc() {
  cachedToc ??= parseBookToc({
    docsDir: DOCS_DIR,
    indexFile: "index.md",
    repoDocsPrefix: "doc",
    baseUrl: DOCS_BASE,
    overviewGroupTitle: "Manual Overview",
    overviewItemTitle: MANUAL_TITLE,
    partHeadingDepths: [2],
    partMatcher: /^Part(?:\s|\u2014|—)/i,
    formatEntry: ({ part, indexTitle }) => ({
      kicker: part.title.replace(/^Part\s+[IVXLCDM0-9]+\s*[—:-]\s*/i, "").trim(),
      badge: "",
      title: indexTitle,
    }),
    appendices: [
      {
        rel: `../${SKILL_REPO_PATH}`,
        repoRel: SKILL_REPO_PATH,
        absPath: SKILL_PATH,
        slug: "skill",
        href: SKILL_ROUTE,
        kicker: "Agent Skill",
        title: "Using titan-mk (Agent Skill)",
        summary: "Operational guide for coding agents that write, review, or test titan-mk applications.",
        fallbackPartTitle: "Agent Skill",
      },
    ],
  });
  return cachedToc;
}

/** Kicker shown above a manual page's H1. */
export function kickerFor(href) {
  for (const part of getManualToc().parts) {
    const entry = part.entries.find((e) => e.href === href);
    if (entry) return entry.kicker;
  }
  return `${MANUAL_TITLE} · ${SITE.versionBadge}`;
}
