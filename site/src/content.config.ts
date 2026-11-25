import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// `doc/how-to/install-and-build.md` -> `how-to/install-and-build`; `doc/index.md` -> `index`.
const docsId = ({ entry }: { entry: string }) => entry.replace(/\\/g, "/").replace(/\.md$/, "");

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./.generated/docs/doc", generateId: docsId }),
});

const skill = defineCollection({
  loader: glob({ pattern: "SKILL.md", base: "./.generated/docs/skills/titan-mk", generateId: () => "titan-mk" }),
});

const site = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/site" }),
});

export const collections = { docs, skill, site };
