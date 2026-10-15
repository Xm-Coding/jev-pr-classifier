import test from "node:test";
import assert from "node:assert/strict";
import { prepareState, callJev, handleClassify } from "../lib/classifier.ts";
import { parsePRUrl } from "../lib/pr-source.ts";
import { checkServiceStatus } from "../lib/service-status.ts";
import { DEFAULT_MODEL, LONG_REQUEST_BYTES, LONG_CONTEXT_HEADER } from "../lib/model-policy.ts";
import { CATEGORIES } from "../lib/rubric.ts";
const result = () => ({ model: DEFAULT_MODEL, answers: { pr_category: { type: "choice", choice: "bugfix", confidence: 1, probabilities: Object.fromEntries(CATEGORIES.map(c => [c.id, c.id === "bugfix" ? 1 : 0])) } }, usage: {} });
const record = patch => ({ location: parsePRUrl("https://github.com/a/b/pull/1"), title: "Fix", description: "Fix existing behavior", state: "open", headSha: "head", baseSha: "base", files: [{ path: "src/fix.go", status: "modified", additions: 1, deletions: 1, patch }], changedFiles: 1, additions: 1, deletions: 1, warnings: [], diffComplete: true });

test("standard input retains a file beyond the previous 6KB cap without long context", () => {
  const patch = "// rationale\n".repeat(750) + "+critical change at the end";
  const prepared = prepareState(record(patch), DEFAULT_MODEL);
  assert.equal(prepared.contextMode, "standard");
  assert.equal(prepared.state.pr.files[0].diff, patch);
  assert.equal(prepared.inputComplete, true);
});
test("long input retains the end of the diff and full description within the larger budget", () => {
  const patch = "+existing implementation\n".repeat(3000) + "+critical change at the end";
  const pr = record(patch); pr.description = "Design context. ".repeat(1000);
  const prepared = prepareState(pr, DEFAULT_MODEL);
  assert.equal(prepared.contextMode, "long");
  assert.equal(prepared.state.pr.files[0].diff, patch);
  assert.equal(prepared.state.pr.description, pr.description);
  assert.equal(prepared.inputComplete, true);
  assert.ok(prepared.warnings.some(w => w.includes("长上下文")));
});
test("oversized escaped Unicode input stays bounded and reports incomplete evidence", () => {
  const prepared = prepareState(record('"\\\n🧪'.repeat(60000)), DEFAULT_MODEL);
  assert.ok(prepared.requestBytes <= LONG_REQUEST_BYTES);
  assert.equal(prepared.inputComplete, false);
  assert.ok(!prepared.state.pr.files[0].diff.includes("�"));
});
test("pinned model and opt-in header follow actual request size", async () => {
  for (const long of [false, true]) {
    await callJev({ text: long ? "x ".repeat(40000) : "small change" }, { apiKey: "test-only-key" }, async (url, options) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(JSON.parse(options.body).model, "jev-1.14.0");
      assert.equal(options.headers[LONG_CONTEXT_HEADER], long ? "true" : undefined);
      assert.equal(options.redirect, "manual");
      return Response.json(result());
    });
  }
});
test("unknown models do not silently opt in to long context", async () => {
  await assert.rejects(callJev({text:"x".repeat(40000)}, {apiKey:"test-only-key",model:"custom-model"}, async()=>{throw new Error("must not call");}), e=>e.code==="INPUT_TOO_LARGE");
});
test("status verifies an actual inference response from the configured version", async () => {
  const status = await checkServiceStatus({apiKey:"test-only-key"}, async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).model, DEFAULT_MODEL);
    return Response.json({model:DEFAULT_MODEL,answers:{availability_check:{type:"noul",noul:1}}});
  });
  assert.equal(status.verifiedModel, "jev-1.14.0"); assert.equal(status.code, "JEV_INFERENCE_VERIFIED");
});
test("a model list, malformed inference, or wrong version cannot pass the availability probe", async () => {
  for (const payload of [{models:[]}, {model:DEFAULT_MODEL,answers:{availability_check:{type:"noul",noul:2}}}, {model:"jev-1.13.0",answers:{availability_check:{type:"noul",noul:1}}}]) {
    const status=await checkServiceStatus({apiKey:"test-only-key"},async()=>Response.json(payload));
    assert.equal(status.availability,"unavailable"); assert.equal(status.verifiedModel,undefined);
  }
});
test("classification response reports long context without exposing source text or key", async () => {
  const req = new Request("https://site.test/api/classify", {method:"POST",body:JSON.stringify({url:"https://gitee.com/a/b/pulls/1"})});
  const response=await handleClassify(req,{apiKey:"test-only-key"},async(url,options)=>{
    if(String(url).includes("typesafe.ai")){assert.equal(options.headers[LONG_CONTEXT_HEADER],"true");return Response.json(result());}
    return Response.json(String(url).endsWith("/files")?[{filename:"fix.go",patch:"+some code\n".repeat(4000)}]:{title:"Fix",changed_files:1});
  });
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.contextMode,"long");assert.equal(data.inputComplete,true);
  assert.ok(!JSON.stringify(data).includes("test-only-key"));assert.ok(!JSON.stringify(data).includes("+some code"));
});
