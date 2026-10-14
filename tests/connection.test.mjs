import test from "node:test";
import assert from "node:assert/strict";
import { requestSite, SiteRequestError } from "../lib/client-api.ts";
import { checkServiceStatus } from "../lib/service-status.ts";
import { handleClassify } from "../lib/classifier.ts";

test("browser network failure is distinct from Jev rejection", async () => {
  await assert.rejects(requestSite("/api/classify", {}, async () => { throw new TypeError("Failed to fetch"); }), error => error instanceof SiteRequestError && error.code === "SITE_CONNECTION" && !!error.requestId && !error.message.includes("Failed to fetch"));
});
test("sign-in redirects are handled before cross-origin redirect following", async () => {
  await assert.rejects(requestSite("/api/classify", {}, async (_url, init) => { assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "same-origin"); return {type:"opaqueredirect", status:0}; }), error => error.code === "SITE_SIGN_IN");
});
test("gateway HTML is not parsed as a classifier result or exposed", async () => {
  await assert.rejects(requestSite("/api/classify", {}, async () => new Response("<html>secret gateway details</html>", {status:403})), error => error.code === "SITE_NON_JSON" && error.message.includes("403") && !error.message.includes("secret"));
});
test("Jev error code and request correlation survive browser handling", async () => {
  const id=crypto.randomUUID();
  await assert.rejects(requestSite("/api/classify", {}, async () => Response.json({error:{code:"JEV_REGION_UNAVAILABLE",message:"HTTP 451",requestId:id}}, {status:502})), error => error.code === "JEV_REGION_UNAVAILABLE" && error.requestId === id);
});
test("successful results keep raw model probabilities", async () => {
  const payload={choice:"bugfix",confidence:0.847,probabilities:{bugfix:0.87}};
  assert.deepEqual(await requestSite("/api/classify", {}, async ()=>Response.json(payload)),payload);
});
test("availability checks distinguish configured key from reachable service", async () => {
  const status=await checkServiceStatus({apiKey:"test-secret"}, async (_url,init)=>{assert.equal(init.headers.Authorization,"Bearer test-secret");return new Response("do not expose upstream",{status:451});});
  assert.equal(status.ready,true);assert.equal(status.availability,"unavailable");assert.equal(status.code,"JEV_REGION_UNAVAILABLE");assert.ok(!JSON.stringify(status).includes("test-secret"));
  const missing=await checkServiceStatus({},async()=>{throw new Error("must not fetch");});assert.equal(missing.availability,"not_configured");
});
test("backend errors include safe request ID and failed stage",async()=>{
  const id=crypto.randomUUID();const req=new Request("https://example.test/api/classify",{method:"POST",headers:{"X-Request-ID":id},body:JSON.stringify({url:"https://github.com/a/b/pull/1"})});
  const response=await handleClassify(req,{apiKey:"test-secret"},async()=>new Response("source error",{status:404}));
  const data=await response.json();assert.equal(data.error.stage,"pr_source");assert.equal(data.error.requestId,id);assert.equal(response.headers.get("X-Request-ID"),id);
});
