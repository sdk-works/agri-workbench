import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from './model-gateway.mjs';
const env={JUDGE_BASE_URL:'https://open.bigmodel.cn/api/paas/v4',JUDGE_CLOUD_MODEL:'glm-4.7-flash',JUDGE_API_KEY:'test'};
const ok=()=>({ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})});
test('pre-connect failure retries once but ambiguous reset is never replayed',async()=>{
 let n=0;
 const g=createGateway(env,null,{fetcher:async()=>{
   if(++n===1)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
   return ok();
 }});
 assert.equal((await g.call('judge',[])).answer,'ok');assert.equal(n,2);
 n=0;
 const h=createGateway(env,null,{fetcher:async()=>{n++;throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});}});
 await assert.rejects(h.call('judge',[]),e=>e.code==='network'&&e.message.includes('ECONNRESET'));assert.equal(n,1);
});
test('429 releases response and shares Retry-After cooldown with later requests',async()=>{
 let n=0,canceled=0;
 const g=createGateway(env,null,{fetcher:async()=>{
  n++;return {ok:false,status:429,headers:{get:()=> '120'},body:{cancel:async()=>canceled++}};
 }});
 await assert.rejects(g.call('judge',[]),e=>e.code==='rate_limited'&&e.retry_after_ms>110000);
 await assert.rejects(g.call('judge',[]),{code:'rate_limited'});
 assert.equal(n,1);assert.equal(canceled,1);
});
test('partial stream failure preserves emitted tokens and does not replay',async()=>{
 let requests=0,reads=0,partial='';
 const g=createGateway(env,null,{fetcher:async()=>{
  requests++;return {ok:true,body:{getReader:()=>({read:async()=>{
   if(reads++===0)return {done:false,value:new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分答案"}}]}\n\n')};
   throw Error('socket disconnected');
  },cancel:async()=>{}})}};
 }});
 await assert.rejects(g.call('judge',[],false,undefined,d=>partial+=d),{code:'stream_interrupted'});
 assert.equal(partial,'部分答案');assert.equal(requests,1);
});
test('provider overload and exhausted quota are distinguished without exposing raw payload',async()=>{
 for(const [providerCode,code] of [['1305','rate_limited'],['1113','configuration'],['insufficient_quota','configuration']]){
  const g=createGateway(env,null,{fetcher:async()=>({ok:false,status:429,json:async()=>({error:{code:providerCode,message:'sensitive raw data'}})})});
  await assert.rejects(g.call('judge',[]),e=>e.code===code&&e.message.includes(providerCode)&&!e.message.includes('sensitive'));
 }
});
