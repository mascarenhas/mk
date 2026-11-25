import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { createRemarkCassiniDocs, rehypeCassiniTables } from "@titan-lang/cassini/markdown";
import { cassiniDarkTheme, cassiniPrintTheme, loadTitanLanguage } from "@titan-lang/cassini/shiki";
import { docsRouteForRepoPath } from "./src/routes.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const titanLang = loadTitanLanguage(
  path.join(ROOT, ".generated/sources/vscode-titan/syntaxes/titan.tmLanguage.json"),
);
const repoUrl = `https://github.com/${sources.mk.repo}`;
const repoLinkRe = new RegExp(
  `^${repoUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/blob/[^/]+/((?:doc/.+|skills/titan-mk/SKILL)\\.md)(#.*)?$`,
  "i",
);

const remarkCassiniDocs = createRemarkCassiniDocs({
  sections: [
    {
      // Staged copies of ../doc and ../skills keep their repository-relative paths.
      matchPath: "/.generated/docs/",
      repoUrl,
      ref: sources.mk.ref,
      resolveInternal: docsRouteForRepoPath,
      rewriteExternal(url) {
        const m = url.match(repoLinkRe);
        return m ? docsRouteForRepoPath(m[1], m[2] || "") : null;
      },
    },
  ],
});

export default defineConfig({
  site: "https://mk.titan-lang.dev",
  trailingSlash: "always",
  markdown: {
    processor: unified({
      remarkPlugins: [remarkCassiniDocs],
      rehypePlugins: [rehypeCassiniTables],
    }),
    shikiConfig: {
      themes: {
        dark: cassiniDarkTheme,
        light: cassiniPrintTheme,
      },
      defaultColor: "dark",
      langs: [titanLang],
    },
  },
});
