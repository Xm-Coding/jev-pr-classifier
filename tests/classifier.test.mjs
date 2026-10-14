import test from "node:test";
import assert from "node:assert/strict";
import { parsePRUrl, normalizeFile, fetchPR } from "../lib/pr-source.ts";
import { prepareState, validateJevResponse, handleClassify, callJev } from "../lib/classifier.ts";
import { CATEGORIES, CLASSIFICATION_QUESTION } from "../lib/rubric.ts";
const response = () => ({ model: "jev-1.13.0", answers: { pr_category: { type: "choice", choice: "bugfix", confidence: 0.883333, probabilities: Object.fromEntries(CATEGORIES.map(c => [c.id, c.id === "bugfix" ? 0.9 : 0.1 / 6])) } }, usage: { input_tokens: 1000, output_tokens: 30 } });
const record = () => ({ location: parsePRUrl("https://gitee.com/dromara/sa-token/pulls/378"), title: "Fix concurrency error", description: "Fix a race condition", state: "merged", headSha: "head", baseSha: "base", files: [{ path: "src/auth.java", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-unsafe\n+safe // explain intent" }], changedFiles: 1, additions: 3, deletions: 1, warnings: [], diffComplete: true });

test("parse canonical PR URLs and reject arbitrary fetch targets", () => {
  assert.equal(parsePRUrl("https://github.com/a/b/pull/12/files?foo=bar#diff").url, "https://github.com/a/b/pull/12");
  assert.equal(parsePRUrl("https://gitcode.com/a/b/merge_requests/9").provider, "gitcode");
  assert.equal(parsePRUrl("https://atomgit.com/a/b/merge_requests/9").provider, "atomgit");
  for (const value of ["http://127.0.0.1/pull/1", "https://github.com.evil.test/a/b/pull/1", "https://secret@github.com/a/b/pull/1", "https://github.com/a/b/issues/1", "https://github.com/a%2Fb/c/pull/1", "https://gitee.com/a/b/pulls/0"]) assert.throws(() => parsePRUrl(value));
});
test("normalize live object-shaped patches and string-valued counts", () => {
  const file = normalizeFile({ additions: "19", deletions: "2", patch: { diff: "+ok", new_path: "lib.java", new_file: true } });
  assert.deepEqual(file, { path: "lib.java", status: "added", additions: 19, deletions: 2, patch: "+ok" });
});
test("Gitee files are not paginated and Jev credentials never reach provider", async () => {
  const seen = [];
  const fetcher = async (url, options) => { seen.push(String(url)); assert.equal(options.headers.Authorization, undefined); return Response.json(String(url).endsWith("/files") ? [{ filename: "a.java", patch: { diff: "+a" } }] : { title: "Fix", body: "body", changed_files: 1 }); };
  const pr = await fetchPR(parsePRUrl("https://gitee.com/a/b/pulls/1"), { apiKey: "not-a-source-token" }, fetcher);
  assert.equal(pr.files[0].patch, "+a"); assert.equal(pr.diffComplete, true); assert.equal(seen.length, 2); assert.ok(!seen[1].includes("page="));
});
test("Github follows file pagination and keeps all returned files", async () => {
  const fetcher = async url => { const page = new URL(url).searchParams.get("page"); return Response.json(page === "1" ? Array.from({length: 100}, (_, i) => ({ filename: `file${i}`, patch: "+a" })) : page === "2" ? [{filename: "last", patch: "+z"}] : { title: "Fix", changed_files: 101 }); };
  const pr = await fetchPR(parsePRUrl("https://github.com/a/b/pull/1"), {}, fetcher);
  assert.equal(pr.files.length, 101); assert.equal(pr.diffComplete, true);
});
test("preserve code comments as evidence and enforce request byte budget", () => {
  const pr = record(); const small = prepareState(pr, "jev-1.13.0"); assert.match(small.state.pr.files[0].diff, /explain intent/);
  pr.description = "详细说明".repeat(7000); pr.files[0].patch = "改动内容🧪".repeat(30000);
  const large = prepareState(pr, "jev-1.13.0");
  const bytes = new TextEncoder().encode(JSON.stringify({model: "jev-1.13.0", state: large.state, questions: {pr_category: CLASSIFICATION_QUESTION}})).length;
  assert.ok(bytes <= 28000); assert.equal(large.inputComplete, false); assert.ok(large.warnings.length); assert.ok(!large.state.pr.files[0].diff.includes("�"));
});
test("incomplete source evidence cannot become complete during preprocessing", () => { const pr = record(); pr.diffComplete = false; pr.warnings = ["missing diff"]; assert.equal(prepareState(pr, "jev-1.13.0").inputComplete, false); });
test("validate seven probabilities without rescaling API confidence", () => {
  assert.equal(CATEGORIES.length, 7); const r = response(); const a = validateJevResponse(r); assert.equal(a.confidence, r.answers.pr_category.confidence); assert.equal(a.probabilities.bugfix, 0.9);
  delete r.answers.pr_category.probabilities.feature; assert.throws(() => validateJevResponse(r));
});
test("upstream authentication errors never disclose bodies or keys", async () => {
  await assert.rejects(callJev({}, { apiKey: "test-secret" }, async () => new Response("test-secret in upstream error", {status: 401})), e => e.code === "JEV_AUTH" && !e.message.includes("test-secret"));
});
test("regional unavailability is reported separately from invalid credentials", async () => {
  await assert.rejects(callJev({}, { apiKey: "test-secret" }, async () => new Response("region unavailable", {status: 451})), e => e.code === "JEV_REGION_UNAVAILABLE");
});
test("reject cross-origin requests before source or API calls", async () => {
  const request = new Request("https://example.test/api/classify", { method: "POST", headers: {Origin: "https://evil.test"}, body: JSON.stringify({url: "https://github.com/a/b/pull/1"}) });
  const result = await handleClassify(request, {apiKey: "test-secret"}, async () => { throw new Error("must not fetch"); }); assert.equal(result.status, 403);
});
test("whole request uses real provider content and expected Jev schema", async () => {
  const fetcher = async (url, options) => {
    if (String(url).includes("typesafe.ai")) { assert.equal(options.headers.Authorization, "Bearer test-secret"); const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body.questions.pr_category.criteria), CATEGORIES.map(c => c.id)); assert.match(body.state.pr.files[0].diff, /safe/); return Response.json(response()); }
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(String(url).endsWith("/files") ? [{ filename: "fix.java", patch: {diff: "+safe"} }] : {title: "Fix", changed_files: 1});
  };
  const request = new Request("https://example.test/api/classify", {method: "POST", headers: {Origin: "https://example.test"}, body: JSON.stringify({url: "https://gitee.com/a/b/pulls/1"})});
  const result = await handleClassify(request, {apiKey: "test-secret"}, fetcher); const data = await result.json();
  assert.equal(result.status, 200); assert.equal(data.choice, "bugfix"); assert.equal(Object.keys(data.probabilities).length, 7); assert.ok(!JSON.stringify(data).includes("test-secret")); assert.equal(data.inputComplete, true);
});
