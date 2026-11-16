/**
 * Environment for the Playwright-managed production servers. The values and the isolation rules
 * live in `e2e/env.mjs` (plain ESM, so the Node scripts that build and run the tests can share
 * them); this module only re-exports them for the TypeScript tests and the Playwright config.
 */
export * from "./env.mjs";
