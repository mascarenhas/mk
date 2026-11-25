#!/usr/bin/env node
/**
 * Prepares every build input the site does not commit. Uses Node built-ins only,
 * so it runs before `npm ci` (which links `@titan-lang/cassini` from
 * `.generated/cassini`).
 *
 *   .generated/cassini/                       <- titan-lang-dev packages/cassini (pinned)
 *   .generated/sources/vscode-titan/...       <- Titan TextMate grammar (pinned)
 *   .generated/sources/titan/...              <- Titan crest SVG (pinned)
 *   .generated/docs/doc/, .generated/docs/skills/titan-mk/SKILL.md
 *                                             <- this checkout's ../doc and ../skills
 *   public/fonts/                             <- Cassini's vendored WOFF2 fonts
 *   public/assets/titan-logo.svg              <- Titan crest
 *
 * Pinned sources come from immutable GitHub commit tarballs cached in
 * `.generated/cache/`. Local overrides for previewing unreleased checkouts:
 *   CASSINI_LOCAL_DIR / --cassini-dir <titan-lang-dev checkout>
 *   CASSINI_LOCAL_REF / --cassini-ref <ref>       (optional; `git archive <ref>` instead of the working tree)
 *   VSCODE_TITAN_LOCAL_DIR / --vscode-dir <vscode-titan checkout>
 *   VSCODE_TITAN_LOCAL_REF / --vscode-ref <ref>   (default origin/main; always `git archive`)
 *   TITAN_LOCAL_DIR / --titan-dir <titan checkout>
 *   TITAN_LOCAL_REF / --titan-ref <ref>           (optional; `git archive <ref>` instead of the working tree)
 *   FETCH_SOURCES_FORCE=1 / --force               (re-extract pinned sources)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ROOT, "..");
const SOURCES_JSON_PATH = path.join(ROOT, "sources.json");
const GENERATED_DIR = path.join(ROOT, ".generated");
const CACHE_DIR = path.join(GENERATED_DIR, "cache");
const SOURCES_DIR = path.join(GENERATED_DIR, "sources");
const CASSINI_DIR = path.join(GENERATED_DIR, "cassini");
const DOCS_DIR = path.join(GENERATED_DIR, "docs");
const STAMP_PATH = path.join(GENERATED_DIR, "sources.stamp.json");

function expandHome(p) {
  if (!p) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const opts = {
    cassiniDir: expandHome(process.env.CASSINI_LOCAL_DIR || ""),
    cassiniRef: process.env.CASSINI_LOCAL_REF || "",
    vscodeDir: expandHome(process.env.VSCODE_TITAN_LOCAL_DIR || ""),
    vscodeRef: process.env.VSCODE_TITAN_LOCAL_REF || "",
    titanDir: expandHome(process.env.TITAN_LOCAL_DIR || ""),
    titanRef: process.env.TITAN_LOCAL_REF || "",
    force: process.env.FETCH_SOURCES_FORCE === "1",
  };
  const flags = {
    "--cassini-dir": ["cassiniDir", true],
    "--cassini-ref": ["cassiniRef", false],
    "--vscode-dir": ["vscodeDir", true],
    "--vscode-ref": ["vscodeRef", false],
    "--titan-dir": ["titanDir", true],
    "--titan-ref": ["titanRef", false],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") {
      opts.force = true;
    } else if (flags[a] && argv[i + 1]) {
      const [key, isPath] = flags[a];
      const val = argv[++i];
      opts[key] = isPath ? expandHome(val) : val;
    } else {
      throw new Error(`Unknown or incomplete argument: ${a}`);
    }
  }
  return opts;
}

/** Empties `dir` while keeping the listed entries (e.g. npm's nested node_modules). */
function resetDir(dir, keep = []) {
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (!keep.includes(entry)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => path.basename(p) !== "node_modules" && path.basename(p) !== ".DS_Store",
  });
}

/** Extracts `relPaths` at `ref` from a local git repository into `stageDir` (working tree untouched). */
function extractViaGitArchive(repoDir, ref, relPaths, stageDir) {
  const absRepo = path.resolve(repoDir);
  if (!fs.existsSync(absRepo)) throw new Error(`Local repository does not exist: ${absRepo}`);
  const archive = spawnSync("git", ["-C", absRepo, "archive", "--format=tar", ref, "--", ...relPaths], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`git -C ${absRepo} archive ${ref} failed: ${archive.stderr?.toString("utf8") || ""}`);
  }
  const untar = spawnSync("tar", ["-xf", "-", "-C", stageDir], { input: archive.stdout });
  if (untar.status !== 0) {
    throw new Error(`tar extract into ${stageDir} failed: ${untar.stderr?.toString("utf8") || ""}`);
  }
  const sha = execFileSync("git", ["-C", absRepo, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  return { mode: "git-archive", repoDir: absRepo, ref, sha };
}

function copyFromWorkingTree(repoDir, relPaths, stageDir) {
  const absRepo = path.resolve(repoDir);
  if (!fs.existsSync(absRepo)) throw new Error(`Local directory does not exist: ${absRepo}`);
  for (const rel of relPaths) {
    const src = path.join(absRepo, rel);
    if (!fs.existsSync(src)) throw new Error(`Expected path missing in local checkout: ${src}`);
    const dst = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyTree(src, dst);
  }
  let sha = "working-tree";
  try {
    sha = execFileSync("git", ["-C", absRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout
  }
  return { mode: "local-copy", repoDir: absRepo, sha };
}

async function downloadFile(url, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp-${process.pid}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "mk-titan-lang-dev-fetch-sources/1.0" },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, destFile);
}

async function extractFromGithubTarball(key, spec, stageDir) {
  if (!/^[0-9a-f]{40}$/.test(spec.sha || "")) {
    throw new Error(`sources.json ${key}.sha must be a 40-character commit SHA`);
  }
  const tarPath = path.join(CACHE_DIR, `${key}-${spec.sha}.tar.gz`);
  if (!fs.existsSync(tarPath) || fs.statSync(tarPath).size === 0) {
    const url = `https://github.com/${spec.repo}/archive/${spec.sha}.tar.gz`;
    console.log(`[fetch-sources] Downloading ${spec.repo}@${spec.sha.slice(0, 10)}...`);
    await downloadFile(url, tarPath);
  }
  // GitHub archives use a single top-level directory: "<repo>-<sha>/".
  const prefix = `${spec.repo.split("/")[1]}-${spec.sha}`;
  const entries = spec.paths.map((p) => `${prefix}/${p.replace(/^\/+/, "")}`);
  execFileSync("tar", ["-xzf", tarPath, "--strip-components=1", "-C", stageDir, ...entries], {
    stdio: "inherit",
  });
  return { mode: "github-tarball", repo: spec.repo, ref: spec.ref, sha: spec.sha };
}

async function materialize({ key, spec, localDir, localRef, defaultLocalRef = "" }) {
  const stageDir = fs.mkdtempSync(path.join(GENERATED_DIR, `.stage-${key}-`));
  let meta;
  if (localDir) {
    const ref = localRef || defaultLocalRef;
    meta = ref
      ? extractViaGitArchive(localDir, ref, spec.paths, stageDir)
      : copyFromWorkingTree(localDir, spec.paths, stageDir);
    console.log(`[fetch-sources] ${key} <- ${meta.mode} ${meta.repoDir}${ref ? ` (${ref})` : ""} @ ${meta.sha.slice(0, 10)}`);
  } else {
    meta = await extractFromGithubTarball(key, spec, stageDir);
    console.log(`[fetch-sources] ${key} <- GitHub ${spec.repo}@${spec.sha.slice(0, 10)}`);
  }
  return { stageDir, meta };
}

function moveStaged(stageDir, rel, destDir, keep = []) {
  const src = path.join(stageDir, rel);
  if (!fs.existsSync(src)) throw new Error(`Staged path missing: ${rel}`);
  resetDir(destDir, keep);
  for (const entry of fs.readdirSync(src)) {
    fs.renameSync(path.join(src, entry), path.join(destDir, entry));
  }
}

/**
 * Escapes unescaped `|` inside backtick code spans on GFM table rows so that
 * spans such as `a | b` survive cell splitting. Skips fenced code blocks and
 * is idempotent. (Mirrors @titan-lang/cassini/markdown#escapeTableInlineCodePipes,
 * reimplemented here so this script needs no installed packages.)
 */
export function escapeTableInlineCodePipes(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fenceChar = null;
  let fenceLen = 0;
  let changed = false;

  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const ch = fence[1][0];
      const len = fence[1].length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && trimmed.slice(len).trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      return line;
    }
    if (fenceChar || !trimmed.startsWith("|")) return line;

    let res = "";
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (line[i] === "`") {
        let j = i;
        while (j < n && line[j] === "`") j++;
        const ticks = j - i;
        let k = j;
        let closeIdx = -1;
        while (k < n) {
          if (line[k] === "`") {
            let m = k;
            while (m < n && line[m] === "`") m++;
            if (m - k === ticks) {
              closeIdx = k;
              break;
            }
            k = m;
          } else {
            k++;
          }
        }
        if (closeIdx !== -1) {
          const inner = line.slice(j, closeIdx);
          const escaped = inner.replace(/(?<!\\)\|/g, "\\|");
          if (escaped !== inner) changed = true;
          res += line.slice(i, j) + escaped + line.slice(closeIdx, closeIdx + ticks);
          i = closeIdx + ticks;
          continue;
        }
      }
      res += line[i];
      i++;
    }
    return res;
  });

  return changed ? out.join("\n") : markdown;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Stages this checkout's manual and agent skill, mirroring their repository paths. */
function stageDocs(mkSpec) {
  resetDir(DOCS_DIR);
  for (const rel of mkSpec.paths) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) throw new Error(`Missing documentation source: ${src}`);
    const dst = path.join(DOCS_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyTree(src, dst);
  }
  let mdFiles = 0;
  let escaped = 0;
  for (const file of walkFiles(DOCS_DIR)) {
    if (!file.endsWith(".md")) continue;
    mdFiles++;
    const raw = fs.readFileSync(file, "utf8");
    const normalized = escapeTableInlineCodePipes(raw);
    if (normalized !== raw) {
      fs.writeFileSync(file, normalized, "utf8");
      escaped++;
    }
  }
  console.log(
    `[fetch-sources] Staged ${mdFiles} Markdown file(s) from ${mkSpec.paths.join(", ")}` +
      (escaped ? ` (escaped table code-span pipes in ${escaped})` : ""),
  );
}

function syncPublicAssets() {
  const fontsSrc = path.join(CASSINI_DIR, "src/fonts/web");
  const fontsDst = path.join(ROOT, "public/fonts");
  const woff2 = fs.readdirSync(fontsSrc).filter((n) => n.endsWith(".woff2")).sort();
  if (woff2.length === 0) throw new Error(`No .woff2 files in ${fontsSrc}`);
  resetDir(fontsDst);
  for (const name of woff2) fs.copyFileSync(path.join(fontsSrc, name), path.join(fontsDst, name));
  fs.copyFileSync(path.join(CASSINI_DIR, "src/fonts/LICENSES.txt"), path.join(fontsDst, "LICENSES.txt"));

  const logoDst = path.join(ROOT, "public/assets/titan-logo.svg");
  fs.mkdirSync(path.dirname(logoDst), { recursive: true });
  fs.copyFileSync(path.join(SOURCES_DIR, "titan/doc/images/titan-logo.svg"), logoDst);
}

function pinnedSentinelsPresent() {
  return [
    path.join(CASSINI_DIR, "package.json"),
    path.join(CASSINI_DIR, "src/fonts/web/IBMPlexSans-Regular.woff2"),
    path.join(SOURCES_DIR, "vscode-titan/syntaxes/titan.tmLanguage.json"),
    path.join(SOURCES_DIR, "titan/doc/images/titan-logo.svg"),
  ].every((p) => fs.existsSync(p));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawSources = fs.readFileSync(SOURCES_JSON_PATH, "utf8");
  const sources = JSON.parse(rawSources);
  const sourcesHash = crypto.createHash("sha256").update(rawSources).digest("hex");
  const isLocalMode = Boolean(opts.cassiniDir || opts.vscodeDir || opts.titanDir);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });

  let upToDate = false;
  if (!isLocalMode && !opts.force && fs.existsSync(STAMP_PATH) && pinnedSentinelsPresent()) {
    try {
      const prev = JSON.parse(fs.readFileSync(STAMP_PATH, "utf8"));
      upToDate = prev.mode === "github" && prev.sourcesHash === sourcesHash;
    } catch {
      // Unreadable stamp: re-extract.
    }
  }

  if (upToDate) {
    console.log(
      `[fetch-sources] Pinned sources up to date (cassini@${sources.cassini.sha.slice(0, 7)}, ` +
        `vscode-titan@${sources.vscodeTitan.sha.slice(0, 7)}, titan ${sources.titan.ref})`,
    );
  } else {
    const cassini = await materialize({
      key: "cassini",
      spec: sources.cassini,
      localDir: opts.cassiniDir,
      localRef: opts.cassiniRef,
    });
    // Keep npm's nested node_modules (if any) so a refresh never breaks an installed tree.
    moveStaged(cassini.stageDir, "packages/cassini", CASSINI_DIR, ["node_modules"]);

    const vscode = await materialize({
      key: "vscode-titan",
      spec: sources.vscodeTitan,
      localDir: opts.vscodeDir,
      localRef: opts.vscodeRef,
      defaultLocalRef: "origin/main",
    });
    moveStaged(vscode.stageDir, ".", path.join(SOURCES_DIR, "vscode-titan"));

    const titan = await materialize({
      key: "titan",
      spec: sources.titan,
      localDir: opts.titanDir,
      localRef: opts.titanRef,
    });
    moveStaged(titan.stageDir, ".", path.join(SOURCES_DIR, "titan"));

    for (const s of [cassini, vscode, titan]) fs.rmSync(s.stageDir, { recursive: true, force: true });

    fs.writeFileSync(
      STAMP_PATH,
      JSON.stringify(
        {
          mode: isLocalMode ? "local" : "github",
          sourcesHash,
          fetchedAt: new Date().toISOString(),
          cassini: cassini.meta,
          vscodeTitan: vscode.meta,
          titan: titan.meta,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  syncPublicAssets();
  stageDocs(sources.mk);
}

main().catch((err) => {
  console.error("[fetch-sources] ERROR:", err.message || err);
  process.exit(1);
});
