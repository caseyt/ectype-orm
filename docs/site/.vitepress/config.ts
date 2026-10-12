import { defineConfig } from "vitepress";

// Skeleton from step 01. Step 20 owns the structure, theme and tooling of this site;
// feature steps add their guide pages under guide/.
export default defineConfig({
  title: "Ectype",
  description: "A TypeScript ORM modelled on Elixir's Ecto: schemas, changesets, queries and a Repo.",
  // Set DOCS_BASE (e.g. "/ectype-orm/") when the site is served from a sub-path.
  base: process.env.DOCS_BASE ?? "/",
  cleanUrls: true,
  lastUpdated: true,
  // Checked example sources live beside the pages but are not pages themselves.
  srcExclude: ["examples/**"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "API", link: "/api/" },
      { text: "Ecto cheat sheet", link: "/ecto/" },
    ],
    sidebar: {
      "/guide/": [{ text: "Guide", items: [{ text: "Overview", link: "/guide/" }] }],
      "/api/": [{ text: "API reference", items: [{ text: "Overview", link: "/api/" }] }],
      "/ecto/": [{ text: "Coming from Ecto", items: [{ text: "Cheat sheet", link: "/ecto/" }] }],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/caseyt/ectype-orm" }],
  },
});
