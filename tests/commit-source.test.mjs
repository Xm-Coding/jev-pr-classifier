import test from "node:test";
import assert from "node:assert/strict";
import { parseContributionUrl, parsePRUrl, fetchContribution, contributionLabel, parseUnifiedDiff } from "../lib/pr-source.ts";
import { prepareState, handleClassify } from "../lib/classifier.ts";
import { parseBatchInput, batchToCsv } from "../lib/batch.ts";
import { CATEGORIES, CLASSIFICATION_QUESTION, RUBRIC_VERSION } from "../lib/rubric.ts";

const sha = "abcdef12".repeat(5);
const parent = "1".repeat(40);
const location = (provider = "github", ref = sha) => parseContributionUrl(`https://${provider}.com/owner/project/commit/${ref}`);
const file = (i = 0) => ({ filename: `src/file${i}.ts`, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+fixed" });
const meta = (files = [file()], parents = [{ sha: parent }]) => ({ sha, commit: { message: "Fix request race\n\nRetain the most recent result." }, parents, stats: { additions: 1, deletions: 1 }, files });
const diff = i => `diff --git a/src/file${i}.ts b/src/file${i}.ts\n--- a/src/file${i}.ts\n+++ b/src/file${i}.ts\n@@ -1 +1 @@\n-old\n+fixed\n`;

test("commit URL parsing supports all providers and only immutable hexadecimal references", () => {
  for (const provider of ["github", "gitee", "gitcode", "atomgit"]) {
    const parsed = parseContributionUrl(`https://${provider}.com/owner/project/commit/${sha.toUpperCase()}?x=1#diff`);
    assert.equal(parsed.kind, "commit"); assert.equal(parsed.sha, sha); assert.equal(parsed.provider, provider);
    assert.equal(parsed.url, `https://${provider}.com/owner/project/commit/${sha}`);
    assert.equal(parsed.number, undefined);
  }
  assert.equal(location("github", sha.slice(0, 7)).sha, sha.slice(0, 7));
  assert.equal(parseContributionUrl(`https://github.com/owner/project//commit/${sha}`).url, location().url);
  for (const url of [`https://github.com/a/b/commit/main`, `https://github.com/a/b/commit/${"a".repeat(41)}`, `https://github.com/a/b/commit/aaaaaa`, `https://github.com.evil.test/a/b/commit/${sha}`, `https://secret@github.com/a/b/commit/${sha}`, `https://github.com/a/b/commit/${sha}/../issues/1`]) assert.throws(() => parseContributionUrl(url));
  assert.throws(() => parsePRUrl(location().url));
  assert.equal(parseContributionUrl("https://github.com/a/b/pull/1").kind, "pr");
});

test("a batch accepts commits and PRs together and deduplicates canonical commit URLs", () => {
  const parsed = parseBatchInput(`${location().url}\n${location().url.toUpperCase()}?x=1#diff\nhttps://gitee.com/a/b/pulls/2`);
  assert.equal(parsed.tasks.length, 2); assert.equal(parsed.duplicateCount, 1); assert.equal(parsed.issues.length, 0);
});

test("GitHub commit fetch pins pagination to the resolved SHA without reading any PR", async () => {
  const seen = [];
  const pr = await fetchContribution(location("github", sha.slice(0, 7)), { githubToken: "source-token", apiKey: "jev-secret" }, async (url, options) => {
    seen.push(String(url)); assert.equal(options.headers.Authorization, "Bearer source-token"); assert.equal(options.redirect, "manual");
    assert.ok(!String(url).includes("pulls"));
    return Response.json(meta(String(url).includes("page=2") ? [file(100)] : Array.from({ length: 100 }, (_, i) => file(i))));
  });
  assert.equal(seen.length, 2); assert.ok(seen[0].includes(`/commits/${sha.slice(0, 7)}?`)); assert.ok(seen[1].includes(`/commits/${sha}?`));
  assert.equal(pr.files.length, 101); assert.equal(pr.headSha, sha); assert.equal(pr.baseSha, parent); assert.equal(pr.diffComplete, true);
  assert.equal(pr.location.sha, sha); assert.equal(pr.location.number, undefined); assert.equal(pr.comparison, "first-parent");
});

test("Gitee commit token stays on its API and object-shaped patches are normalized", async () => {
  const pr = await fetchContribution(location("gitee"), { giteeToken: "gitee-secret", apiKey: "jev-secret" }, async (url, options) => {
    assert.equal(new URL(url).hostname, "gitee.com"); assert.equal(new URL(url).searchParams.get("access_token"), "gitee-secret");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(meta([{ ...file(), patch: { diff: "+fixed", new_path: "src/file0.ts" } }]));
  });
  assert.equal(pr.files[0].patch, "+fixed"); assert.equal(pr.diffComplete, true);
});

test("GitCode uses show_diff metadata and singular commit diff API, recovering files beyond its 100-file list", async () => {
  const seen = [];
  const pr = await fetchContribution(location("gitcode"), { gitcodeToken: "gitcode-source" }, async (url, options) => {
    seen.push(String(url)); assert.equal(options.headers.Authorization, "Bearer gitcode-source");
    if (String(url).endsWith(`/commit/${sha}/diff`)) return new Response(Array.from({ length: 102 }, (_, i) => diff(i)).join(""));
    assert.ok(String(url).endsWith(`/commits/${sha}?show_diff=true`));
    return Response.json(meta(Array.from({ length: 100 }, (_, i) => ({ ...file(i), patch: undefined }))));
  });
  assert.equal(seen.length, 2); assert.equal(pr.files.length, 102); assert.equal(pr.changedFiles, 102); assert.equal(pr.diffComplete, true);
});

test("root and merge commits carry explicit comparison scope into the model input", async () => {
  for (const parents of [[], [{ sha: parent }, { sha: "2".repeat(40) }]]) {
    const pr = await fetchContribution(location(), {}, async () => Response.json(meta([file()], parents)));
    const prepared = prepareState(pr, "jev-1.14.0");
    assert.equal(pr.comparison, parents.length ? "first-parent" : "empty-tree");
    assert.equal(prepared.state.pr.source_type, "commit"); assert.equal(prepared.state.pr.parent_count, parents.length);
    assert.equal(pr.baseSha, parents[0]?.sha ?? null); assert.equal(contributionLabel(pr.location), `Commit ${sha.slice(0, 12)}`);
  }
});

test("mismatched commit identity, inconsistent pages and empty commits cannot produce a classification", async () => {
  await assert.rejects(fetchContribution(location(), {}, async () => Response.json({ ...meta(), sha: "3".repeat(40) })), e => e.code === "SOURCE_FORMAT");
  await assert.rejects(fetchContribution(location(), {}, async (url) => Response.json(String(url).includes("page=2") ? { ...meta(), sha: "3".repeat(40) } : meta(Array.from({ length: 100 }, (_, i) => file(i))))), e => e.code === "SOURCE_FORMAT");
  await assert.rejects(fetchContribution(location(), {}, async (url) => String(url).includes("per_page") ? Response.json(meta([])) : new Response("")), e => e.code === "SOURCE_NO_CHANGES");
});

test("truncated provider patches and the 300-file cap remain incomplete", async () => {
  const truncated = await fetchContribution(location("gitee"), {}, async url => String(url).endsWith(".diff") ? new Response("", { status: 403 }) : Response.json({ ...meta([{ ...file(), truncated: true }]), truncated: true }));
  assert.equal(truncated.diffComplete, false); assert.ok(truncated.warnings.length);
  const capped = await fetchContribution(location(), {}, async () => Response.json(meta(Array.from({ length: 100 }, (_, i) => file(i)))));
  assert.equal(capped.files.length, 300); assert.equal(capped.diffComplete, false);
  const binary = await fetchContribution(location(), {}, async (_url, options) => options.headers.Accept === 'application/vnd.github.diff'
    ? new Response('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n')
    : Response.json(meta([{ ...file(), filename: 'logo.png', patch: undefined }])));
  assert.equal(binary.files[0].path, 'logo.png'); assert.equal(binary.diffComplete, false);
  assert.ok(binary.warnings.some(w => /二进制变更/.test(w)));
});

test("anonymous GitHub commit fallback verifies patch SHA and always requests review", async () => {
  const seen = [];
  const pr = await fetchContribution(location(), { apiKey: "jev-secret" }, async (url, options) => {
    seen.push(String(url)); assert.equal(options.headers.Authorization, undefined);
    return String(url).startsWith("https://api.github.com") ? new Response(null, { status: 403 }) : new Response(`From ${sha} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Fix request race\n\nPreserve latest result.\n---\n src/file0.ts | 2 +-\n\n${diff(0)}`);
  });
  assert.equal(seen[1], location().url + ".patch"); assert.equal(pr.title, "Fix request race"); assert.equal(pr.diffComplete, false); assert.equal(pr.comparison, "unknown");
  let calls = 0;
  await assert.rejects(fetchContribution(location(), { githubToken: "configured" }, async () => { calls++; return new Response(null, { status: 401 }); }), e => e.code === "SOURCE_ACCESS_LIMIT");
  assert.equal(calls, 1);
});

test("Git diff decodes quoted UTF-8 paths and retains renamed, deleted and binary files", () => {
  const quoted = String.raw`diff --git "a/\346\226\207\346\241\243/a.txt" "b/\346\226\207\346\241\243/a.txt"
--- "a/\346\226\207\346\241\243/a.txt"
+++ "b/\346\226\207\346\241\243/a.txt"
@@ -1 +1 @@
-old
+new
`;
  const renamed = 'diff --git "a/old name.txt" "b/new name.txt"\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n';
  const binary = 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n';
  const deleted = 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n';
  assert.deepEqual([...parseUnifiedDiff(quoted + renamed + binary + deleted).keys()], ['文档/a.txt', 'new name.txt', 'logo.png', 'gone.txt']);
});

test("oversized public patch falls back to small diff without claiming verified metadata", async () => {
  const seen = [];
  const record = await fetchContribution(location(), {}, async url => {
    seen.push(String(url));
    if (String(url).startsWith('https://api.github.com')) return new Response('API rate limit exceeded', { status: 403 });
    if (String(url).endsWith('.patch')) return new Response('x'.repeat(6_000_001));
    assert.equal(String(url), location().url + '.diff'); return new Response(diff(0));
  });
  assert.equal(seen.length, 3); assert.equal(record.files[0].path, 'src/file0.ts');
  assert.equal(record.headSha, null); assert.equal(record.comparison, 'unknown');
  assert.equal(prepareState(record, 'jev-1.14.0').inputComplete, false);
  assert.match(record.warnings[0], /SHA.*未验证/);
});

test("PDF content refusal on public patch can recover through public diff", async () => {
  const record = await fetchContribution(location(), {}, async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    if (String(url).startsWith('https://api.github.com')) return new Response(null, { status: 429 });
    if (String(url).endsWith('.patch')) return new Response('Content containing PDF or PS header bytes cannot be rendered from this domain for security reasons.', { status: 403 });
    return new Response(diff(0));
  });
  assert.equal(record.files.length, 1); assert.equal(record.diffComplete, false);
});

test("failed source fallbacks preserve each HTTP status and do not disclose upstream bodies", async () => {
  await assert.rejects(fetchContribution(location(), {}, async url => {
    if (String(url).startsWith('https://api.github.com')) return new Response('API rate limit exceeded source-secret', { status: 403 });
    if (String(url).endsWith('.patch')) return new Response('PDF or PS header bytes source-secret', { status: 403 });
    return new Response(null, { status: 302, headers: { Location: 'https://github.com/login?access_token=source-secret' } });
  }), error => {
    assert.equal(error.code, 'SOURCE_FALLBACK_FAILED');
    assert.deepEqual(error.details.attempts.map(x => x.httpStatus), [403, 403, 302]);
    assert.match(error.message, /访问限额/); assert.match(error.message, /PDF\/PS/); assert.match(error.message, /登录/);
    assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes('source-secret'));
    return true;
  });
});

test("mismatched patch identity fails closed without using an unverified diff", async () => {
  let calls = 0;
  await assert.rejects(fetchContribution(location(), {}, async url => {
    calls++;
    return String(url).startsWith('https://api.github.com') ? new Response(null, { status: 403 }) : new Response(`From ${'9'.repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Wrong commit\n\n${diff(0)}`);
  }), e => e.code === 'SOURCE_FALLBACK_FAILED' && /SHA/.test(e.message));
  assert.equal(calls, 2);
});

test("commit classification sends current rules with commit scope and returns a truthful contribution identity", async () => {
  const request = new Request("https://site.test/api/classify", { method: "POST", body: JSON.stringify({ url: location().url }) });
  const response = await handleClassify(request, { apiKey: "jev-secret" }, async (url, options) => {
    if (String(url).includes("typesafe.ai")) {
      const body = JSON.parse(options.body);
      assert.equal(body.state.pr.source_type, "commit"); assert.equal(body.state.pr.comparison, "first-parent");
      assert.match(body.questions.pr_category.instructions, /单次 Git commit/);
      assert.ok(body.questions.pr_category.instructions.endsWith(CLASSIFICATION_QUESTION.instructions));
      assert.deepEqual(body.questions.pr_category.criteria, CLASSIFICATION_QUESTION.criteria);
      return Response.json({ model: "jev-1.14.0", answers: { pr_category: { type: "choice", choice: "bugfix", confidence: 1, probabilities: Object.fromEntries(CATEGORIES.map(c => [c.id, c.id === "bugfix" ? 1 : 0])) } }, usage: {} });
    }
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(meta());
  });
  const result = await response.json(); assert.equal(response.status, 200);
  assert.equal(result.pr.location.kind, "commit"); assert.equal(result.pr.location.sha, sha); assert.equal(result.pr.location.number, undefined);
  assert.equal(result.rubricVersion, RUBRIC_VERSION); assert.ok(!JSON.stringify(result).includes("jev-secret")); assert.ok(!JSON.stringify(result).includes("+fixed"));
  assert.ok(batchToCsv([{ id: "commit", url: location().url, status: "success", result }], .85).includes(`"Commit","${sha}","first-parent"`));
});
