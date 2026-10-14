import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
let count = 0;
function check(path) {
  if (statSync(path).isDirectory()) { for (const f of readdirSync(path)) check(join(path, f)); return; }
  if (!/\.(?:ts|tsx|js|mjs|json|html|css|md|svg)$/.test(path)) return;
  count++;
  if (/apikey_[A-Za-z0-9_]{40,}/.test(readFileSync(path, "utf8"))) throw new Error(`Credential detected in ${path}`);
}
for (const root of ["app", "lib", "scripts", "build", "dist", ".openai", "README.md"]) check(root);
console.log(`Credential scan passed (${count} source/build files).`);
