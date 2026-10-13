import { defineConfig } from "vitepress";

// Step 20 owns the theme and the tooling of this site; the guide pages live under guide/.
export default defineConfig({
  title: "Egon ORM",
  description: "A TypeScript ORM with schemas, changesets, composable queries and a repo, typed end to end.",
  // Set DOCS_BASE (e.g. "/ectype-orm/") when the site is served from a sub-path.
  base: process.env.DOCS_BASE ?? "/",
  cleanUrls: true,
  lastUpdated: true,
  // Checked example sources live beside the pages but are not pages themselves.
  srcExclude: ["examples/**"],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Reference", link: "/reference/errors" },
      { text: "API", link: "/api/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Start here",
          items: [
            { text: "Introduction", link: "/guide/" },
            { text: "Getting started", link: "/guide/getting-started" },
          ],
        },
        {
          text: "Modelling data",
          items: [
            { text: "Schemas", link: "/guide/schemas" },
            { text: "Types", link: "/guide/types" },
            { text: "Associations and preloading", link: "/guide/associations" },
            { text: "Embeds", link: "/guide/embeds" },
          ],
        },
        {
          text: "Changing data",
          items: [
            { text: "Changesets", link: "/guide/changesets" },
            { text: "Validation", link: "/guide/validation" },
            { text: "Constraints", link: "/guide/constraints" },
            { text: "Nested changesets", link: "/guide/nested-changesets" },
          ],
        },
        {
          text: "Querying",
          items: [
            { text: "Queries", link: "/guide/queries" },
            { text: "Expressions", link: "/guide/query-expressions" },
            { text: "Advanced queries", link: "/guide/queries-advanced" },
          ],
        },
        {
          text: "The repo",
          items: [
            { text: "Repo: setup, reads, writes", link: "/guide/repo" },
            { text: "Transactions", link: "/guide/transactions" },
            { text: "Batch", link: "/guide/batch" },
            { text: "Adapters", link: "/guide/adapters" },
            { text: "Testing", link: "/guide/testing" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Errors", link: "/reference/errors" },
            { text: "Dialect support", link: "/reference/dialect-support" },
            { text: "Roadmap", link: "/reference/roadmap" },
          ],
        },
      ],
      "/api/": [{ text: "API reference", items: [{ text: "Overview", link: "/api/" }] }],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/caseyt/ectype-orm" }],
  },
});
