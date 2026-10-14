import http from "node:http";
import { spawn } from "node:child_process";
import { handleClassify } from "../lib/classifier.ts";
const config = { apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL || "jev-1.13.0", githubToken: process.env.GITHUB_TOKEN, giteeToken: process.env.GITEE_TOKEN, gitcodeToken: process.env.GITCODE_TOKEN, atomgitToken: process.env.ATOMGIT_TOKEN };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:5173");
  if (url.pathname === "/api/status") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ready: Boolean(config.apiKey), model: config.model })); return; }
  if (url.pathname !== "/api/classify") { res.writeHead(404); res.end(); return; }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
  const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
  const origin = req.headers.origin; const publicOrigin = origin === "http://127.0.0.1:5173" ? origin : "http://localhost:5173";
  const response = await handleClassify(new Request(`${publicOrigin}/api/classify`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), config);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
});
server.listen(8788, "127.0.0.1", () => console.log("Local API ready on 127.0.0.1:8788"));
const safeEnv = { ...process.env }; for (const key of ["TYPESAFE_API_KEY", "GITHUB_TOKEN", "GITEE_TOKEN", "GITCODE_TOKEN", "ATOMGIT_TOKEN"]) delete safeEnv[key];
const child = spawn(process.execPath, ["--import", "./scripts/sites-env.mjs", "scripts/run-framework.mjs", "dev"], { env: safeEnv, stdio: "inherit" });
const stop = () => { child.kill("SIGTERM"); server.close(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
child.once("exit", code => { server.close(); process.exit(code || 0); });
