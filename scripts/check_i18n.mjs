/* Check i18n parity: every key used in app.js (t("...")) and every
   data-i18n key in index.html must exist in BOTH languages, and both
   languages must have exactly the same key set. Exit non-zero on any
   gap. Run: node scripts/check_i18n.mjs */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { I18N } from "../frontend/i18n.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appJs = readFileSync(path.join(root, "frontend", "app.js"), "utf-8");
const indexHtml = readFileSync(path.join(root, "frontend", "index.html"), "utf-8");

const used = new Set();
for (const m of appJs.matchAll(/(?<![A-Za-z0-9_$])t\("([^"]+)"\)/g)) used.add(m[1]);
for (const m of indexHtml.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);

const enKeys = new Set(Object.keys(I18N.en));
const zhKeys = new Set(Object.keys(I18N.zh));
let failures = 0;

for (const key of [...used].sort()) {
  if (!enKeys.has(key)) { console.log(`FAIL missing in en: ${key}`); failures++; }
  if (!zhKeys.has(key)) { console.log(`FAIL missing in zh: ${key}`); failures++; }
}
for (const key of [...enKeys].sort()) {
  if (!zhKeys.has(key)) { console.log(`FAIL in en but not zh: ${key}`); failures++; }
}
for (const key of [...zhKeys].sort()) {
  if (!enKeys.has(key)) { console.log(`FAIL in zh but not en: ${key}`); failures++; }
}
console.log(`used keys: ${used.size}, en keys: ${enKeys.size}, zh keys: ${zhKeys.size}, failures: ${failures}`);
if (failures > 0) process.exit(1);
console.log("I18N PARITY OK");
