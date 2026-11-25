#!/usr/bin/env node
/**
 * Post-build verification for `dist/`:
 *   - Crawls every `dist/**\/*.html` page
 *   - Verifies 0 broken internal links (case-sensitive!)
 *   - Verifies 0 missing `#fragment` target IDs
 *   - Verifies 0 broken internal image / stylesheet / script asset references
 *   - Verifies 0 `fonts.googleapis.com` / `fonts.gstatic.com` leaks across HTML/CSS/SVG
 *   - Verifies 0 leaked `<!-- doc-check: ... -->` comments
 *   - Verifies 0 un-rewritten links to this repository's `doc/**.md` / SKILL.md on GitHub
 *   - Verifies required artifacts (`404.html`, `pagefind/pagefind.js`, `_headers`,
 *     one page per staged `doc/**.md`) and that every manual page is in the docs sidebar
 *   - Verifies Cloudflare Workers Static Assets limits (< 25 MiB/file, < 20,000 files)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.resolve(process.argv[2] || path.join(ROOT, "dist"));
const STAGED_DOCS_DIR = path.join(ROOT, ".generated/docs/doc");
const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const ORIGIN = "https://mk.titan-lang.dev";
const UNREWRITTEN_DOC_LINK = new RegExp(
  `^https://github\\.com/${SOURCES.mk.repo.replace("/", "\\/")}/blob/[^/]+/(?:doc/.+|skills/titan-mk/SKILL)\\.md(?:#.*)?$`,
  "i",
);

const CF_MAX_FILE_BYTES = 25 * 1024 * 1024; // 26,214,400 bytes
const CF_MAX_FILE_COUNT = 20000;

function walkAllFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkAllFiles(abs, baseDir));
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, abs).split(path.sep).join("/");
      const size = fs.statSync(abs).size;
      out.push({ abs, rel, size });
    }
  }
  return out;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripNonMarkupTags(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

function extractIds(html) {
  const ids = new Set();
  const clean = stripNonMarkupTags(html);
  for (const m of clean.matchAll(/\bid=(?:"([^"]+)"|'([^']+)')/gi)) {
    const val = decodeHtmlEntities(m[1] ?? m[2] ?? "");
    if (val) ids.add(val);
  }
  return ids;
}

function routePathForHtmlFile(relFile) {
  if (relFile === "index.html") return "/";
  if (relFile.endsWith("/index.html")) return `/${relFile.slice(0, -"index.html".length)}`;
  return `/${relFile}`;
}

function resolveDistFile(pathname, allFilesSet) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep raw
  }
  const clean = decoded.replace(/^\/+/, "");
  if (clean === "") {
    return allFilesSet.has("index.html") ? "index.html" : null;
  }
  if (clean.endsWith("/")) {
    const idx = `${clean}index.html`;
    return allFilesSet.has(idx) ? idx : null;
  }
  if (allFilesSet.has(clean)) return clean;
  const idx = `${clean}/index.html`;
  if (allFilesSet.has(idx)) return idx;
  return null;
}
function parseSrcsetUrls(srcset) {
  // Split srcset candidates separated by commas (allowing optional width/density descriptors).
  const urls = [];
  const parts = srcset.split(",");
  for (const rawPart of parts) {
    const trimmed = rawPart.trim();
    if (!trimmed) continue;
    const token = trimmed.split(/\s+/)[0];
    if (token) urls.push(token);
  }
  return urls;
}

function extractCssUrls(cssText) {
  // Strip CSS /* ... */ comments before scanning url(...)
  const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const urls = [];
  for (const m of noComments.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]+))\s*\)/gi)) {
    const val = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (val) urls.push(val);
  }
  return urls;
}

function isExternalOrDataUri(raw) {
  return (
    !raw ||
    /^https?:\/\//i.test(raw) ||
    /^data:/i.test(raw) ||
    /^mailto:/i.test(raw) ||
    /^tel:/i.test(raw) ||
    /^blob:/i.test(raw) ||
    raw.startsWith("#")
  );
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[verify-site] ERROR: dist directory does not exist: ${DIST_DIR}`);
    process.exit(1);
  }

  const allFiles = walkAllFiles(DIST_DIR);
  const allFilesSet = new Set(allFiles.map((f) => f.rel));
  const errors = [];

  // 1. Cloudflare Workers limits & required outputs
  if (allFiles.length >= CF_MAX_FILE_COUNT) {
    errors.push(`File count ${allFiles.length} reaches/exceeds Cloudflare limit (${CF_MAX_FILE_COUNT})`);
  }

  let largestFile = { rel: "", size: 0 };
  for (const f of allFiles) {
    if (f.size > largestFile.size) largestFile = { rel: f.rel, size: f.size };
    if (f.size >= CF_MAX_FILE_BYTES) {
      errors.push(`Oversized asset (>= 25 MiB): ${f.rel} (${(f.size / 1048576).toFixed(2)} MiB)`);
    }
    if (/\.ttf$/i.test(f.rel)) {
      errors.push(`Cassini print (TTF) font leaked into web dist/: dist/${f.rel}`);
    }
  }

  // Every staged `doc/**.md` must render to `/docs/<slug>/`, plus the fixed routes.
  const docPages = walkAllFiles(STAGED_DOCS_DIR)
    .filter((f) => f.rel.endsWith(".md"))
    .map((f) => (f.rel === "index.md" ? "docs/index.html" : `docs/${f.rel.slice(0, -3)}/index.html`));
  const requiredFiles = [
    "index.html",
    "404.html",
    "_headers",
    "pagefind/pagefind.js",
    "assets/titan-logo.svg",
    "fonts/source-serif-4-latin-opsz-normal.woff2",
    "fonts/IBMPlexSans-Regular.woff2",
    "fonts/IBMPlexMono-Regular.woff2",
    "fonts/LICENSES.txt",
    "skill/index.html",
    "changelog/index.html",
    ...docPages,
  ];
  for (const req of requiredFiles) {
    if (!allFilesSet.has(req)) {
      errors.push(`Missing required output artifact: dist/${req}`);
    }
  }

  // Every manual page must be reachable from the manual sidebar.
  const docsIndexHtml = allFilesSet.has("docs/index.html")
    ? fs.readFileSync(path.join(DIST_DIR, "docs/index.html"), "utf8")
    : "";
  for (const page of [...docPages, "skill/index.html"]) {
    const route = routePathForHtmlFile(page);
    if (!docsIndexHtml.includes(`href="${route}"`)) {
      errors.push(`Manual page /${page} is not linked from the docs sidebar (missing from doc/index.md Part tables?)`);
    }
  }

  // 2. Scan HTML/CSS/SVG for Google Fonts leaks
  let fontLeaks = 0;
  for (const f of allFiles) {
    if (!/\.(html|css|svg)$/i.test(f.rel)) continue;
    const text = fs.readFileSync(f.abs, "utf8");
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(text)) {
      fontLeaks++;
      errors.push(`Google Fonts leak detected in dist/${f.rel}`);
    }
  }

  // 3. Crawl all HTML pages, index IDs, then verify every link, fragment & asset ref
  const htmlFiles = allFiles.filter((f) => f.rel.endsWith(".html"));
  const htmlCache = new Map();
  const idsByFile = new Map();
  let docCheckLeaks = 0;

  for (const f of htmlFiles) {
    const raw = fs.readFileSync(f.abs, "utf8");
    htmlCache.set(f.rel, raw);
    idsByFile.set(f.rel, extractIds(raw));
    if (/<!--\s*doc-check:/i.test(raw)) {
      docCheckLeaks++;
      errors.push(`Leaked doc-check HTML comment in dist/${f.rel}`);
    }
  }

  const stats = {
    totalFiles: allFiles.length,
    htmlPages: htmlFiles.length,
    docsPages: htmlFiles.filter((f) => f.rel.startsWith("docs/")).length,
    unrewrittenDocLinks: 0,
    linksChecked: 0,
    internalLinks: 0,
    fragmentLinks: 0,
    externalLinks: 0,
    assetRefsChecked: 0,
    cssAssetRefsChecked: 0,
    srcsetRefsChecked: 0,
    brokenLinks: 0,
    brokenFragments: 0,
    brokenAssets: 0,
    brokenTableBackticks: 0,
    fontLeaks,
    docCheckLeaks,
    largestAsset: {
      path: largestFile.rel,
      sizeMiB: +(largestFile.size / 1048576).toFixed(2),
    },
  };

  for (const f of htmlFiles) {
    const pageRoute = routePathForHtmlFile(f.rel);
    const clean = stripNonMarkupTags(htmlCache.get(f.rel));

    // Check <a href="...">
    for (const m of clean.matchAll(/<a\b[^>]*?\bhref=(?:"([^"]*)"|'([^']*)')/gi)) {
      const rawHref = decodeHtmlEntities((m[1] ?? m[2] ?? "").trim());
      if (!rawHref) continue;
      stats.linksChecked++;

      if (UNREWRITTEN_DOC_LINK.test(rawHref)) {
        stats.unrewrittenDocLinks++;
        errors.push(`Un-rewritten GitHub doc link in dist/${f.rel}: ${rawHref}`);
        continue;
      }

      const isSameOrigin = rawHref === ORIGIN || rawHref.startsWith(`${ORIGIN}/`);
      if (!isSameOrigin && (/^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref) || /^tel:/i.test(rawHref))) {
        stats.externalLinks++;
        continue;
      }

      if (rawHref.startsWith("#")) {
        stats.internalLinks++;
        stats.fragmentLinks++;
        const frag = decodeURIComponent(rawHref.slice(1));
        if (frag && !idsByFile.get(f.rel)?.has(frag)) {
          stats.brokenFragments++;
          errors.push(`Missing same-page fragment in dist/${f.rel}: #${frag}`);
        }
        continue;
      }

      stats.internalLinks++;
      let urlObj;
      try {
        urlObj = new URL(rawHref, `${ORIGIN}${pageRoute}`);
      } catch {
        stats.brokenLinks++;
        errors.push(`Malformed href in dist/${f.rel}: ${rawHref}`);
        continue;
      }

      const targetFile = resolveDistFile(urlObj.pathname, allFilesSet);
      if (!targetFile) {
        stats.brokenLinks++;
        errors.push(`Broken internal link in dist/${f.rel}: ${rawHref} -> ${urlObj.pathname}`);
        continue;
      }

      if (urlObj.hash && urlObj.hash.length > 1) {
        stats.fragmentLinks++;
        let frag = urlObj.hash.slice(1);
        try {
          frag = decodeURIComponent(frag);
        } catch {
          // Keep raw
        }
        if (targetFile.endsWith(".html") && !idsByFile.get(targetFile)?.has(frag)) {
          stats.brokenFragments++;
          errors.push(`Missing fragment in dist/${f.rel}: ${rawHref} (dist/${targetFile} lacks id="${frag}")`);
        }
      }
    }

    // Check <img src="...">, <script src="...">, <source src="...">
    const rawHtml = htmlCache.get(f.rel);
    for (const m of rawHtml.matchAll(/<(img|script|source)\b[^>]*?\bsrc=(?:"([^"]*)"|'([^']*)')/gi)) {
      const src = decodeHtmlEntities((m[2] ?? m[3] ?? "").trim());
      if (isExternalOrDataUri(src)) continue;
      stats.assetRefsChecked++;
      const urlObj = new URL(src, `${ORIGIN}${pageRoute}`);
      if (!resolveDistFile(urlObj.pathname, allFilesSet)) {
        stats.brokenAssets++;
        errors.push(`Broken <${m[1]}> src in dist/${f.rel}: ${src}`);
      }
    }

    // Check <img srcset="..."> and <source srcset="...">
    for (const m of clean.matchAll(/<(img|source)\b[^>]*?\bsrcset=(?:"([^"]*)"|'([^']*)')/gi)) {
      const srcset = decodeHtmlEntities((m[2] ?? m[3] ?? "").trim());
      for (const candidate of parseSrcsetUrls(srcset)) {
        if (isExternalOrDataUri(candidate)) continue;
        stats.assetRefsChecked++;
        stats.srcsetRefsChecked++;
        const urlObj = new URL(candidate, `${ORIGIN}${pageRoute}`);
        if (!resolveDistFile(urlObj.pathname, allFilesSet)) {
          stats.brokenAssets++;
          errors.push(`Broken <${m[1]}> srcset candidate in dist/${f.rel}: ${candidate}`);
        }
      }
    }

    for (const m of clean.matchAll(/<link\b[^>]*?\bhref=(?:"([^"]*)"|'([^']*)')/gi)) {
      const href = decodeHtmlEntities((m[1] ?? m[2] ?? "").trim());
      if (isExternalOrDataUri(href)) continue;
      stats.assetRefsChecked++;
      const urlObj = new URL(href, `${ORIGIN}${pageRoute}`);
      if (!resolveDistFile(urlObj.pathname, allFilesSet)) {
        stats.brokenAssets++;
        errors.push(`Broken <link> href in dist/${f.rel}: ${href}`);
      }
    }

    // Check url(...) inside inline <style> blocks
    for (const styleMatch of rawHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const cssUrl of extractCssUrls(styleMatch[1])) {
        if (isExternalOrDataUri(cssUrl)) continue;
        stats.assetRefsChecked++;
        stats.cssAssetRefsChecked++;
        const urlObj = new URL(cssUrl, `${ORIGIN}${pageRoute}`);
        if (!resolveDistFile(urlObj.pathname, allFilesSet)) {
          stats.brokenAssets++;
          errors.push(`Broken inline <style> url() in dist/${f.rel}: ${cssUrl}`);
        }
      }

    }
    // Check <td> / <th> text outside <code>/<pre> for stray backticks from split GFM pipe tables
    for (const cellMatch of clean.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      const outsideCode = cellMatch[1]
        .replace(/<(?:code|pre)\b[^>]*>[\s\S]*?<\/(?:code|pre)>/gi, "")
        .replace(/<[^>]+>/g, "");
      if (outsideCode.includes("`")) {
        stats.brokenTableBackticks++;
        errors.push(
          `Split GFM table inline-code backtick in dist/${f.rel}: ${outsideCode.trim().slice(0, 80)}`,
        );
      }
    }
  }

  // 4. Scan all emitted CSS files for url(...) asset references (e.g. self-hosted @font-face WOFF2s)
  for (const f of allFiles) {
    if (!f.rel.endsWith(".css")) continue;
    const cssText = fs.readFileSync(f.abs, "utf8");
    const cssBase = `${ORIGIN}/${f.rel}`;
    for (const cssUrl of extractCssUrls(cssText)) {
      if (isExternalOrDataUri(cssUrl)) continue;
      stats.assetRefsChecked++;
      stats.cssAssetRefsChecked++;
      let urlObj;
      try {
        urlObj = new URL(cssUrl, cssBase);
      } catch {
        stats.brokenAssets++;
        errors.push(`Malformed CSS url() in dist/${f.rel}: ${cssUrl}`);
        continue;
      }
      if (!resolveDistFile(urlObj.pathname, allFilesSet)) {
        stats.brokenAssets++;
        errors.push(`Broken CSS url() in dist/${f.rel}: ${cssUrl} -> ${urlObj.pathname}`);
      }
    }
  }

  console.log("[verify-site] Summary:\n" + JSON.stringify(stats, null, 2));

  if (errors.length > 0) {
    console.error(`\n[verify-site] FAILED with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 50)) {
      console.error("  - " + e);
    }
    if (errors.length > 50) {
      console.error(`  ... and ${errors.length - 50} more`);
    }
    process.exit(1);
  }

  console.log("[verify-site] PASS — 0 errors.");
}

main();
