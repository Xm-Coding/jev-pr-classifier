import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

test("outbound request contract works in deployed workerd runtime without forwarding credentials on redirects", async () => {
  // This exercises Workers' actual Request validation, which differs from Node fetch.
  const entry = `import {callJev} from './lib/classifier.ts';
    import {checkServiceStatus} from './lib/service-status.ts';
    import {fetchPR,parsePRUrl} from './lib/pr-source.ts';
    import {CATEGORIES} from './lib/rubric.ts';
    export default {async fetch(){
      const fetcher=async (url,options)=>{
        new Request(url,options);
        if(String(url).includes('typesafe.ai'))return Response.json({model:'test',answers:{pr_category:{type:'choice',choice:'bugfix',confidence:1,probabilities:Object.fromEntries(CATEGORIES.map(c=>[c.id,c.id==='bugfix'?1:0]))}},usage:{}});
        return Response.json(String(url).includes('/files')?[{filename:'fix.go',patch:'+fix'}]:{title:'Fix',changed_files:1});
      };
      const answer=await callJev({}, {apiKey:'test-only-key'},fetcher);
      const health=await checkServiceStatus({apiKey:'test-only-key'},fetcher);
      const pr=await fetchPR(parsePRUrl('https://github.com/a/b/pull/1'),{},fetcher);
      let requests=0;let redirectError;
      try{await callJev({}, {apiKey:'test-only-key'},async(url,options)=>{
        new Request(url,options);requests++;return new Response(null,{status:302,headers:{Location:'https://example.test'}});
      });}catch(e){redirectError=e.code;}
      return Response.json({choice:answer.choice,available:health.availability,complete:pr.diffComplete,requests,redirectError});
    }};`;
  const compiled = await build({ stdin:{contents:entry,resolveDir:fileURLToPath(new URL("..",import.meta.url)),sourcefile:"worker-contract.ts"}, bundle:true,write:false,format:"esm",platform:"browser",target:"es2022" });
  const worker = new Miniflare({modules:true,compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],script:compiled.outputFiles[0].text});
  try {
    const data = await (await worker.dispatchFetch("http://worker.test/")).json();
    assert.deepEqual(data,{choice:"bugfix",available:"reachable",complete:true,requests:1,redirectError:"JEV_API_ERROR"});
  } finally { await worker.dispose(); }
});
