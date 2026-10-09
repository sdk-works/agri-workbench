import {randomUUID,createHash,randomInt} from 'node:crypto';

export const choices=['A','B','tie','both_bad','insufficient'];
export function fail(message,status=400){throw Object.assign(new Error(message),{status})}
export function cleanText(value,name,max=30000){if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${name}不能为空且不能超过 ${max} 字符`);return value.trim()}
export function validateJudge(p){
 if(!p||!['A','B','tie'].includes(p.winner))throw new Error('裁判结果缺少有效 winner');
 const dimensions=['accuracy','completeness','actionable','concise'];
 for(const side of ['a','b'])for(const d of dimensions){const x=p[`${side}_${d}`];if(typeof x!=='number'||!Number.isFinite(x)||x<1||x>5)throw new Error('裁判评分必须是 1–5 的数字')}
 return {winner:p.winner,score_a:dimensions.reduce((a,d)=>a+p[`a_${d}`],0)/4,score_b:dimensions.reduce((a,d)=>a+p[`b_${d}`],0)/4,reason:String(p.reason||'').slice(0,2000),dimensions:p};
}
export function publicRecord(record){
 const r=structuredClone(record),revealed=Boolean(r.choice);
 delete r.question_hash;delete r.request_routes;
 for(const c of r.candidates){delete c.route;if(!revealed){delete c.model;delete c.provider;delete c.usage;if(c.error)c.error='该候选生成失败，可保存问题进入专家修订。'}}
 if(!revealed){r.judge={status:'hidden'};r.similarity=null;r.priority=[]}
 return r;
}
function classifyError(e){const message=String(e?.message||e);return {code:/429/.test(message)?'rate_limited':/timeout|超时/i.test(message)?'timeout':/评分|解析|winner/.test(message)?'invalid_output':/配置/.test(message)?'configuration':'upstream_error',message:message.slice(0,600)}}
function priority(r){const tags=[];if(r.similarity?.verdict==='different')tags.push('回答差异');if(r.choice?.value==='both_bad')tags.push('两者都差');if(r.choice?.value==='insufficient')tags.push('信息不足');if(r.judge?.result&&['A','B'].includes(r.choice?.value)&&r.judge.result.winner!==r.choice.value)tags.push('人机判断不一致');if(r.sampled)tags.push('一致样本抽查');if(/用量|剂量|施药|控制|水阀|水泵/.test(r.question))tags.push('关键操作或用量');return tags}

export function createPipeline({store,generate,judge,similarity,first='local_agri',second='local2_agri'}){
 let queue=Promise.resolve();
 const schedule=(job)=>{queue=queue.then(job).catch(e=>console.error('Pipeline task error:',e.message));return queue};
 function create(body){
  const question=cleanText(body.question,'问题',4000),id=cleanText(body.request_id,'request_id',80);
  if(!/^[\w-]{8,80}$/.test(id))fail('request_id 格式不正确');
  const old=store.get(id);if(old){if(old.question!==question)fail('同一请求编号不能用于不同问题',409);return publicRecord(old)}
  if(store.all().filter(r=>r.status==='generating').length>=12)fail('等待生成的任务较多，请稍后再试',429);
  const hash=createHash('sha256').update(question.normalize('NFKC').replace(/\s+/g,'').toLowerCase()).digest('hex');
  const routes=randomInt(2)?[first,second]:[second,first],now=new Date().toISOString();
  const record={id,question,question_hash:hash,created_at:now,updated_at:now,version:1,status:'generating',review_status:'unreviewed',split:parseInt(hash.slice(0,8),16)%5===0?'eval':'train',sampled:parseInt(hash.slice(8,16),16)%10===0,context:[{role:'user',content:question}],candidates:routes.map((route,i)=>({label:i?'B':'A',route,status:'pending',text:''})),choice:null,similarity:null,judge:{status:'not_started'},priority:[],expert:null,approval:null};
  store.create(record);schedule(()=>run(id));return publicRecord(record);
 }
 async function run(id){
  for(let i=0;i<2;i++){
   const r=store.get(id),c=r.candidates[i];
   try{const out=await generate(c.route,r.context);if(!out.answer?.trim())throw new Error('模型返回空回答');store.update(id,p=>Object.assign(p.candidates[i],{status:'completed',text:out.answer,model:out.model,provider:out.provider,usage:out.usage||null}),'candidate_completed')}
   catch(e){store.update(id,p=>Object.assign(p.candidates[i],{status:'failed',error:classifyError(e).message}),'candidate_failed')}
  }
  store.update(id,r=>{const good=r.candidates.filter(c=>c.status==='completed');r.status=good.length===2?'completed':good.length?'partial':'failed';if(good.length===2){r.similarity=similarity(r.candidates[0].text,r.candidates[1].text)}r.priority=priority(r)},'generation_finished');
 }
 function vote(id,body){
  if(!choices.includes(body.choice))fail('选择无效');const actor=cleanText(body.actor,'标注人',80);
  const r=store.update(id,p=>{if(p.choice)fail('已提交盲评，请勿重复选择',409);if(p.status==='generating')fail('请等待生成完成',409);if(p.status!=='completed'&&body.choice!=='insufficient')fail('不足两个回答，只能记录信息不足');p.choice={value:body.choice,actor,at:new Date().toISOString()};p.review_status='pending';p.judge={status:p.status==='completed'?'queued':'unavailable'};p.priority=priority(p)},'human_choice');
  if(r.status==='completed')schedule(()=>runJudge(id));return publicRecord(r);
 }
 async function runJudge(id){
  store.update(id,r=>{r.judge={status:'running'}},'judge_started');
  try{const r=store.get(id);const result=await judge({question:r.question,answerA:r.candidates[0].text,answerB:r.candidates[1].text});store.update(id,p=>{p.judge={status:'completed',result};p.priority=priority(p)},'judge_completed')}
  catch(e){store.update(id,p=>{p.judge={status:'failed',error:classifyError(e)};p.priority=priority(p)},'judge_failed')}
 }
 function edit(id,body){
  const answer=cleanText(body.answer,'专家标准答案'),evidence=cleanText(body.evidence,'依据与适用条件',10000),actor=cleanText(body.actor,'修订人',80);
  return publicRecord(store.update(id,p=>{if(p.review_status==='approved')fail('已审核记录不可修改',409);if(!p.choice)fail('请先提交独立判断',409);if(p.expert?.revision!==(body.revision||undefined)&&p.expert)fail('修订已被其他页面更新，请刷新',409);p.expert={answer,evidence,actor,notes:String(body.notes||'').slice(0,10000),revision:(p.expert?.revision||0)+1,at:new Date().toISOString()};p.review_status='awaiting_review'},'expert_revision'));
 }
 function approve(id,body){
  const actor=cleanText(body.actor,'复审人',80);
  return publicRecord(store.update(id,p=>{
   if(p.review_status!=='awaiting_review'||!p.expert)fail('请先提交专家修订',409);
   if(body.revision!==p.expert.revision)fail('修订版本已变化，请刷新后复审',409);
   if(actor===p.expert.actor||actor===p.choice.actor)fail('复审人应不同于标注人和修订人');
   const pref=body.preferred??null;
   if(pref!==null&&!['A','B'].includes(pref))fail('偏好确认无效');
   if(pref&&(p.status!=='completed'||!['A','B'].includes(p.choice.value)))fail('两者都差、相当、信息不足或生成不完整不能直接成为 DPO 对');
   if(pref&&body.original_acceptable!==true)fail('DPO 需要确认被选原始回答本身合格');
   p.approval={actor,preferred:pref,original_acceptable:pref?true:false,revision:p.expert.revision,at:new Date().toISOString()};p.review_status='approved';
  },'review_approved'));
 }
 function exclude(id,body){const actor=cleanText(body.actor,'处理人',80),reason=cleanText(body.reason,'排除原因',1000);return publicRecord(store.update(id,p=>{if(p.review_status==='approved')fail('已审核记录不可修改',409);if(!p.choice)fail('请先提交独立判断',409);p.review_status='excluded';p.exclusion={actor,reason,at:new Date().toISOString()}},'excluded'))}
 function exportDataset(kind){
  if(!['sft','dpo','eval'].includes(kind))fail('数据集类型无效');
  const rows=store.all().filter(r=>r.review_status==='approved'&&(kind==='eval'?r.split==='eval':r.split==='train'));
  const items=rows.filter(r=>kind!=='dpo'||r.approval.preferred).map(r=>{
   const meta={id:r.id,split:r.split,demo:false,expert:r.expert,approval:r.approval,human_choice:r.choice,similarity:r.similarity,judge:r.judge,candidates:r.candidates.map(({label,provider,model})=>({label,provider,model}))};
   if(kind==='dpo'){const a=r.candidates.find(c=>c.label===r.approval.preferred),b=r.candidates.find(c=>c.label!==r.approval.preferred);return {prompt:r.context,chosen:[{role:'assistant',content:a.text}],rejected:[{role:'assistant',content:b.text}],meta}}
   return {messages:[...r.context,{role:'assistant',content:r.expert.answer}],meta};
  });
  if(!items.length)fail('暂无符合条件的已复审数据',409);
  const result={id:randomUUID(),created_at:new Date().toISOString(),kind,schema_version:1,items};store.saveExport(result);return result;
 }
 function recover(){for(const p of store.all()){
  if(p.status==='generating')store.update(p.id,r=>{for(const c of r.candidates)if(c.status==='pending'){c.status='failed';c.error='服务重启中断，未自动重发模型请求'}r.status=r.candidates.some(c=>c.status==='completed')?'partial':'failed';r.priority=priority(r)},'generation_interrupted');
  if(['queued','running'].includes(p.judge.status))schedule(()=>runJudge(p.id));
 }}
 return {create,vote,edit,approve,exclude,exportDataset,recover,idle:()=>queue,get:id=>{const p=store.get(id);if(!p)fail('记录不存在',404);return publicRecord(p)},list:()=>store.all().map(publicRecord)};
}
