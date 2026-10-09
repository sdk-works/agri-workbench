import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {createPipeline,validateJudge} from './pipeline.mjs';

function fixture(t,overrides={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agri-pipeline-')),filename=path.join(dir,'test.sqlite');
 const store=new Store(filename);t.after(()=>{try{store.close()}catch{}fs.rmSync(dir,{recursive:true,force:true})});
 const called=[];
 const pipe=createPipeline({store,generate:async(route,context)=>{called.push({route,context});return {answer:`${route} 回答`,model:route==='local_agri'?'qwen-test':'mistral-test',provider:'local'}},judge:async()=>({winner:'B',score_a:2,score_b:4,judge_model:'independent-test',provider:'test'}),similarity:()=>({verdict:'different',score:.1}),...overrides});
 return {store,pipe,called,filename,dir};
}
async function make(f,q='农业测试问题'){const p=f.pipe.create({question:q,request_id:randomUUID()});await f.pipe.idle();return f.pipe.get(p.id)}
function revision(f,id,actor='专家'){return f.pipe.edit(id,{actor,answer:'经核实的标准答案',evidence:'资料版本 V1，适用于指定作物阶段'})}
function approved(f,id,preferred=null){f.pipe.vote(id,{choice:preferred||'both_bad',actor:'标注员'});const p=revision(f,id);return f.pipe.approve(id,{actor:'复审员',revision:p.expert.revision,preferred,original_acceptable:Boolean(preferred)})}
async function trainRecord(f){for(let i=0;i<20;i++){const p=await make(f,'训练分组问题'+i);if(p.split==='train')return p}throw Error('no train record')}

test('blind A/B stable on reload; no source or judge before choice; exact chosen mapping',async t=>{
 const f=fixture(t);const p=await make(f);assert.deepEqual(p.candidates.map(c=>c.label),['A','B']);assert(p.candidates.every(c=>!c.model&&!c.provider&&!c.route));assert.equal(p.judge.status,'hidden');assert.equal(p.similarity,null);
 const original=f.store.get(p.id),chosen=original.candidates[0];f.pipe.vote(p.id,{choice:'A',actor:'甲'});await f.pipe.idle();const visible=f.pipe.get(p.id);assert.equal(visible.candidates[0].model,chosen.model);assert(visible.priority.includes('回答差异'));assert(visible.priority.includes('人机判断不一致'));assert.equal(visible.judge.result.judge_model,'independent-test');
 assert.throws(()=>f.pipe.vote(p.id,{choice:'B',actor:'甲'}),/重复/);
});
test('request id is idempotent; same question has frozen split; independent histories',async t=>{
 const f=fixture(t),id=randomUUID();f.pipe.create({question:'番茄温度',request_id:id});f.pipe.create({question:'番茄温度',request_id:id});assert.throws(()=>f.pipe.create({question:'其他',request_id:id}),/不同问题/);await f.pipe.idle();assert.equal(f.called.length,2);const p2=await make(f,'番茄 温度');assert.equal(f.pipe.get(id).split,p2.split);assert(f.called.every(c=>c.context.length===1&&c.context[0].role==='user'));
});
test('late judge writes after choice without losing review or duplicating records',async t=>{
 let resolve;const f=fixture(t,{judge:()=>new Promise(r=>resolve=r)});const p=await make(f);f.pipe.vote(p.id,{choice:'B',actor:'甲'});await new Promise(r=>setTimeout(r,10));revision(f,p.id);resolve({winner:'A',score_a:4,score_b:2,judge_model:'judge'});await f.pipe.idle();assert.equal(f.pipe.get(p.id).review_status,'awaiting_review');assert.equal(f.store.all().length,1);assert.equal(f.pipe.get(p.id).judge.status,'completed');
});
test('partial and failed generation cannot create preference pairs',async t=>{
 const f=fixture(t,{generate:async route=>{if(route==='local2_agri')throw Error('offline');return {answer:'answer',model:'qwen',provider:'local'}}});const p=await make(f);assert.equal(p.status,'partial');assert.throws(()=>f.pipe.vote(p.id,{choice:'A',actor:'甲'}),/不足两个/);f.pipe.vote(p.id,{choice:'insufficient',actor:'甲'});const rev=revision(f,p.id);assert.throws(()=>f.pipe.approve(p.id,{actor:'乙',revision:rev.expert.revision,preferred:'A',original_acceptable:true}),/不能直接/);
});
test('revision concurrency, distinct reviewer and immutable approval enforced',async t=>{
 const f=fixture(t),p=await trainRecord(f);f.pipe.vote(p.id,{choice:'A',actor:'标注员'});const rev=revision(f,p.id);assert.throws(()=>f.pipe.edit(p.id,{actor:'专家',answer:'a',evidence:'b'}),/刷新/);assert.throws(()=>f.pipe.approve(p.id,{actor:'专家',revision:rev.expert.revision}),/不同/);assert.throws(()=>f.pipe.approve(p.id,{actor:'复审员',revision:99}),/版本/);f.pipe.approve(p.id,{actor:'复审员',revision:1});assert.throws(()=>revision(f,p.id),/不可修改/);
});
test('unreviewed and both-bad preferences excluded; SFT uses expert answer, DPO original',async t=>{
 const f=fixture(t),p=await trainRecord(f);assert.throws(()=>f.pipe.exportDataset('sft'),/暂无/);approved(f,p.id,'A');const dpo=f.pipe.exportDataset('dpo');assert.equal(dpo.items[0].chosen[0].content,f.store.get(p.id).candidates[0].text);assert.equal(f.pipe.exportDataset('sft').items[0].messages.at(-1).content,'经核实的标准答案');await f.pipe.idle();
 const q=await trainRecord(f);f.pipe.vote(q.id,{choice:'both_bad',actor:'标注员'});const r=revision(f,q.id);assert.throws(()=>f.pipe.approve(q.id,{actor:'复审员',revision:r.expert.revision,preferred:'A',original_acceptable:true}),/不能直接/);f.pipe.approve(q.id,{actor:'复审员',revision:1});assert.equal(f.pipe.exportDataset('dpo').items.length,1);
});
test('evaluation records never enter training exports',async t=>{
 const f=fixture(t);let p;for(let i=0;i<30;i++){const r=await make(f,'评测问题'+i);if(r.split==='eval'){p=r;break}}assert(p);approved(f,p.id,'A');assert.throws(()=>f.pipe.exportDataset('dpo'),/暂无/);assert.throws(()=>f.pipe.exportDataset('sft'),/暂无/);assert.equal(f.pipe.exportDataset('eval').items.length,1);await f.pipe.idle();
});
test('SQLite reopen and consistent backup preserve records and export snapshot',async t=>{
 const f=fixture(t),p=await trainRecord(f);approved(f,p.id);await f.pipe.idle();f.pipe.exportDataset('sft');const target=path.join(f.dir,'backup.sqlite');await f.store.backupTo(target);const restored=new Store(target);assert.equal(restored.get(p.id).review_status,'approved');assert.equal(restored.db.prepare('SELECT count(*) n FROM exports').get().n,1);restored.close();f.store.close();const reopen=new Store(f.filename);assert.equal(reopen.get(p.id).expert.answer,'经核实的标准答案');reopen.close();
});
test('restart interrupts unfinished generations without silent provider retries',async t=>{
 const f=fixture(t);const p=await make(f);f.store.update(p.id,r=>{r.status='generating';r.candidates[1].status='pending'});f.pipe.recover();assert.equal(f.pipe.get(p.id).status,'partial');assert.match(f.store.get(p.id).candidates[1].error,/重启/);assert.equal(f.called.length,2);
});
test('judge score types/ranges are validated and failures remain distinguishable',async t=>{
 const raw={winner:'A',reason:'ok'};for(const side of ['a','b'])for(const key of ['accuracy','completeness','actionable','concise'])raw[`${side}_${key}`]=3;assert.equal(validateJudge(raw).score_a,3);assert.throws(()=>validateJudge({...raw,a_accuracy:'5'}),/数字/);assert.throws(()=>validateJudge({...raw,b_concise:9}),/数字/);
 const f=fixture(t,{judge:async()=>{throw Error('上游请求超时')}});const p=await make(f);f.pipe.vote(p.id,{choice:'tie',actor:'甲'});await f.pipe.idle();assert.equal(f.pipe.get(p.id).judge.error.code,'timeout');
});
