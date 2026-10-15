import test from "node:test";
import assert from "node:assert/strict";
import { parseBatchInput, runBatch, batchToCsv, reviewAdvice, MAX_BATCH_SIZE } from "../lib/batch.ts";
import { SiteRequestError } from "../lib/client-api.ts";
import { CATEGORIES } from "../lib/rubric.ts";
const tasks = n => Array.from({length:n},(_,i)=>({id:String(i),url:`https://github.com/a/b/pull/${i+1}`}));
const result = (title="Fix") => ({model:"jev-1.14.0",choice:"bugfix",confidence:0.91,probabilities:Object.fromEntries(CATEGORIES.map(c=>[c.id,c.id==="bugfix"?0.922857142857:0.012857142857])),inputComplete:true,contextMode:"standard",pr:{title},warnings:[]});

test("batch links are validated and canonical duplicates only run once",()=>{
  const parsed=parseBatchInput("https://github.com/Org/Repo/pull/12/files?x=1#diff\r\nhttps://github.com/org/repo/pull/12\n\nhttps://gitee.com/a/b/pulls/3\nhttps://github.com.evil.test/a/b/pull/1\nhttps://secret@github.com/a/b/pull/1");
  assert.equal(parsed.tasks.length,2);assert.equal(parsed.duplicateCount,1);assert.deepEqual(parsed.issues.map(x=>x.line),[5,6]);
  assert.equal(parsed.tasks[0].url,"https://github.com/Org/Repo/pull/12");assert.ok(!JSON.stringify(parsed.issues).includes("secret"));
});
test("oversized batches are blocked rather than silently losing links",async()=>{
  const parsed=parseBatchInput(tasks(MAX_BATCH_SIZE+1).map(t=>t.url).join("\n"));assert.equal(parsed.overLimit,true);assert.equal(parsed.tasks.length,MAX_BATCH_SIZE+1);
  await assert.rejects(runBatch(parsed.tasks,{signal:new AbortController().signal,onUpdate:()=>{},worker:async()=>{throw new Error("must not run");}}),/最多/);
  assert.equal(parseBatchInput("x".repeat(80001)).overLimit,true);
});
test("queue caps concurrency at two and preserves input ordering despite out-of-order completion",async()=>{
  let active=0,peak=0;const completed=[];
  const entries=await runBatch(tasks(5),{signal:new AbortController().signal,concurrency:100,onUpdate:e=>{if(e.status==="success")completed.push(e.id);},worker:async task=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,task.id==="0"?30:2));active--;return result(task.id);
  }});
  assert.equal(peak,2);assert.equal(completed[0],"1");assert.deepEqual(entries.map(e=>e.id),["0","1","2","3","4"]);assert.ok(entries.every(e=>e.status==="success"));
});
test("one PR failure retains request correlation and does not stop other entries",async()=>{
  const entries=await runBatch(tasks(3),{signal:new AbortController().signal,onUpdate:()=>{},worker:async task=>{if(task.id==="1")throw new SiteRequestError("SOURCE_ACCESS_LIMIT","Provider refused access","request-1");return result();}});
  assert.deepEqual(entries.map(e=>e.status),["success","error","success"]);assert.equal(entries[1].error.requestId,"request-1");assert.equal(entries[1].result,undefined);
});
test("stopping cancels in-flight waits and never starts pending PRs",async()=>{
  const abort=new AbortController();const started=[];
  const run=runBatch(tasks(8),{signal:abort.signal,onUpdate:()=>{},worker:async(task,signal)=>{
    started.push(task.id);await new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));return result();
  }});
  assert.equal(started.length,2);abort.abort();const entries=await run;assert.equal(started.length,2);assert.ok(entries.every(e=>e.status==="cancelled"));
});
test("pre-cancelled batches issue no requests and duplicate task IDs are rejected",async()=>{
  const abort=new AbortController();abort.abort();const entries=await runBatch(tasks(2),{signal:abort.signal,onUpdate:()=>{},worker:async()=>{throw new Error("must not run");}});assert.ok(entries.every(e=>e.status==="cancelled"));
  await assert.rejects(runBatch([tasks(1)[0],tasks(1)[0]],{signal:new AbortController().signal,onUpdate:()=>{}}),/重复/);
});
test("retrying only unsuccessful entries leaves successful PRs untouched",async()=>{
  const first=await runBatch(tasks(3),{signal:new AbortController().signal,onUpdate:()=>{},worker:async task=>{if(task.id==="1")throw new Error("failed");return result();}});
  const called=[];const retry=await runBatch(first.filter(e=>e.status==="error"),{signal:new AbortController().signal,onUpdate:entry=>{assert.equal(entry.error,undefined);},worker:async task=>{called.push(task.id);return result();}});
  assert.deepEqual(called,["1"]);assert.equal(retry[0].status,"success");assert.equal(retry[0].error,undefined);assert.equal(first[0].status,"success");
});
test("CSV exports all seven raw probabilities, preserves failures, and neutralizes formulas",()=>{
  const r=result('=HYPERLINK("https://example.test","click")\nline two');r.warnings=['warning, with comma'];
  const csv=batchToCsv([{...tasks(1)[0],status:"success",result:r},{id:"failed",url:"https://github.com/a/b/pull/2",status:"error",error:{code:"SOURCE_ERROR",message:"@bad formula",requestId:"request-2"}}],.85);
  assert.ok(csv.startsWith("\uFEFF"));for(const c of CATEGORIES)assert.ok(csv.includes(c.label+"概率(0–1)"));assert.ok(csv.includes('"0.91"'));assert.ok(csv.includes('"'+r.probabilities.bugfix+'"'));
  assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes("'@bad formula"));assert.ok(csv.includes("request-2"));assert.ok(csv.includes('"warning, with comma"'));
});
test("batch review advice applies the same incomplete-input and long-context gates",()=>{
  const r=result();assert.equal(reviewAdvice(r,.85),"达到试验门限");assert.match(reviewAdvice({...r,contextMode:"long"},.85),/长上下文/);assert.match(reviewAdvice({...r,inputComplete:false},.85),/输入不完整/);assert.match(reviewAdvice(r,.95),/低于门限/);
});
