import { configurationReport } from "./preflight.mjs";

/** Playwright `globalSetup`: stop before any test when the app is not wired to the test double. */
export default async function globalSetup() {
  const report = await configurationReport();
  if (report) throw new Error(report);
}
