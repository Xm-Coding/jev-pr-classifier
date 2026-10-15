import test from "node:test";
import assert from "node:assert/strict";
import {fetchPR,parsePRUrl,parseGitHubPublicPage} from "../lib/pr-source.ts";
const location=parsePRUrl("https://github.com/owner/project/pull/7");
const page=()=>`<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({payload:{pullRequestsLayoutRoute:{pullRequest:{number:7,title:"Fix escaping",state:"OPEN",headSha:"head"},repository:{ownerLogin:"owner",name:"project"}}}})}</script><div class="comment-body markdown-body"><p>Fix <code>&lt;input&gt;</code>.</p><div><p>Nested evidence &amp; tests</p></div></div><div class="comment-body">Later comment must not enter description</div>`;
test("public fallback validates repository identity and preserves first description",()=>{
  const data=parseGitHubPublicPage(page(),location);
  assert.match(data.description,/Fix <input>/);assert.match(data.description,/Nested evidence & tests/);assert.ok(!data.description.includes("Later comment"));
  assert.throws(()=>parseGitHubPublicPage(page(),{...location,repo:"other"}));
});
test("anonymous GitHub access rejection can use public page and net diff with explicit review flag",async()=>{
  const seen=[];
  const pr=await fetchPR(location,{apiKey:"jev-secret"},async(url,options)=>{
    seen.push(String(url));assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,"manual");
    return String(url).startsWith("https://api.github.com")?new Response(null,{status:403}):String(url)===location.url?new Response(page()):new Response("diff --git a/fix.go b/fix.go\n--- a/fix.go\n+++ b/fix.go\n@@ -1 +1 @@\n-old\n+new\n");
  });
  assert.equal(pr.title,"Fix escaping");assert.equal(pr.files[0].path,"fix.go");assert.equal(pr.diffComplete,false);assert.ok(pr.warnings.length);assert.equal(seen.length,3);assert.equal(seen[2],"https://patch-diff.githubusercontent.com/raw/owner/project/pull/7.diff");
});
test("configured GitHub credentials are not silently discarded on authorization failure",async()=>{
  let calls=0;await assert.rejects(fetchPR(location,{githubToken:"github-test-token"},async()=>{calls++;return new Response(null,{status:401});}),e=>e.code==="SOURCE_ACCESS_LIMIT");assert.equal(calls,1);
});
