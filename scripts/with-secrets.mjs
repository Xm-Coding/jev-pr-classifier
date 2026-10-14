// Read credentials once from hidden stdin. Nothing is written to disk or argv.
import { fileURLToPath } from "node:url";
const mode = process.argv[2] || "dev";
const input = await new Promise((resolve, reject) => {
  let value = ""; const tty = process.stdin.isTTY;
  if (tty) process.stdin.setRawMode(true);
  process.stderr.write("Ready for runtime environment JSON on stdin (input is hidden).\n");
  process.stdin.setEncoding("utf8");
  const done = () => { process.stdin.removeListener("data", read); process.stdin.pause(); if (tty) process.stdin.setRawMode(false); resolve(value); };
  function read(chunk) { value += chunk; if (value.includes("\u0003") || value.length > 10000) { reject(new Error("Input cancelled or too large")); process.exit(1); } if (value.includes("\n") || value.includes("\r")) done(); }
  process.stdin.on("data", read); process.stdin.resume();
});
let values;
try { values = JSON.parse(input); } catch { throw new Error("Provide one JSON object with runtime environment values."); }
for (const key of ["TYPESAFE_API_KEY", "TYPESAFE_MODEL", "GITHUB_TOKEN", "GITEE_TOKEN", "GITCODE_TOKEN", "ATOMGIT_TOKEN"]) {
  if (typeof values[key] === "string") process.env[key] = values[key];
}
if (mode === "check") {
  let response;
  try { response = await fetch("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` }, signal: AbortSignal.timeout(25000) }); }
  catch { console.log(JSON.stringify({ reachable: false })); process.exit(1); }
  console.log(JSON.stringify({ status: response.status, ok: response.ok }));
} else if (mode === "live-test") {
  const { classifyPR } = await import("../lib/classifier.ts");
  const config = { apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL || "jev-1.13.0" };
  const urls = ["https://gitee.com/dromara/sa-token/pulls/378", "https://gitcode.com/openeuler/docs/merge_requests/635", "https://github.com/psf/requests/pull/7628"];
  for (const url of urls) {
    try { const r = await classifyPR(url, config); console.log(JSON.stringify({ url, model: r.model, category: r.choice, confidence: r.confidence, probabilities: r.probabilities, files: r.pr.changedFiles, complete: r.inputComplete, warnings: r.warnings, tokens: r.usage.input_tokens, elapsedMs: r.elapsedMs })); }
    catch (e) { console.log(JSON.stringify({ url, error: e.code || "CONNECTION_FAILED", message: e.code ? e.message : "Live request failed" })); }
  }
} else if (mode === "dev") {
  await import("./local-dev.mjs");
} else { throw new Error("Use dev, check, or live-test."); }
