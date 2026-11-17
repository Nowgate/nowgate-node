// make sdk-package's check: the SDK installed from its tarball into a clean directory, imported
// by its name as an application imports it, verifies a published signature vector. It runs from
// that directory: node installed.mjs <signature-vectors.json>
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The import, timed: the SDK's modules loaded and evaluated in a fresh process.
const began = performance.now();
const { API_VERSION, Nowgate, VERSION, Webhooks } = await import("nowgate");
const importMs = performance.now() - began;

const require = createRequire(import.meta.url);
const pkg = require("nowgate/package.json");
const entry = fileURLToPath(import.meta.resolve("nowgate"));
const installed = fileURLToPath(new URL("node_modules/nowgate/", import.meta.url));
assert.ok(entry.startsWith(installed), `nowgate loaded from ${entry}, not ${installed}`);

const { vectors } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const v = vectors[0];
const event = await Webhooks.constructEvent(v.body, v.header, v.secrets, { now: v.now });
assert.equal(event.type, "payment.finished");
assert.equal(event.api_version, API_VERSION);
assert.equal(VERSION, pkg.version);
const nowgate = new Nowgate({ apiKey: `ngk_sandbox_${"0123456789".repeat(4)}abc` });
assert.equal(nowgate.baseUrl, "https://sandbox-api.nowgate.io/v1");
const files = readdirSync(installed, { recursive: true, withFileTypes: true }).filter((f) =>
  f.isFile(),
);
const bytes = files.reduce((sum, f) => sum + statSync(`${f.parentPath}/${f.name}`).size, 0);
console.log(
  `nowgate ${VERSION} on Node.js ${process.versions.node}: installed (${bytes} bytes in ${files.length} files), imported in ${importMs.toFixed(1)} ms, a vector verified`,
);
