#!/usr/bin/env node
// Installs the Chrome for Testing build the installed puppeteer-core is built for, into the cache
// directory given as the first argument, and prints the executable's path on stdout. CI uses it so the
// production click smoke has a browser on a runner that has none. It reuses the `@puppeteer/browsers`
// copy puppeteer-core already depends on (so the lockfile pins it) and skips the download when the
// version is already in the cache.
//
//   node scripts/smoke/install-chrome.mjs <cache-dir>
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error("Usage: node scripts/smoke/install-chrome.mjs <cache-dir>");
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { PUPPETEER_REVISIONS } = require("puppeteer-core");
// puppeteer-core's own dependency, resolved from where puppeteer-core lives (pnpm does not hoist it).
const browsersEntry = createRequire(require.resolve("puppeteer-core")).resolve("@puppeteer/browsers");
const { Browser, install } = await import(pathToFileURL(browsersEntry).href);

const { executablePath, buildId } = await install({
  browser: Browser.CHROME,
  buildId: PUPPETEER_REVISIONS.chrome,
  cacheDir: resolve(cacheDir)
});
console.error(`Chrome for Testing ${buildId} at ${executablePath}`);
console.log(executablePath);
