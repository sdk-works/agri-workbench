import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { judgeRetry, validateDifference } from './judge-policy.mjs';
import { fixture } from './test-helpers.mjs';
import { openRepository } from './repository.mjs';
import { createWorkspace } from './workspace.mjs';
import { createGateway } from './model-gateway.mjs';

const turn = { candidates: [{text:'保持湿润，不要积水。'}, {text:'暂停浇水，先检查根系。'}] };
const major = { difference_level:'major', reason:'浇水建议相反', differences:[{type:'action',answer_a:'保持湿润',answer_b:'暂停浇水',impact:'改变浇水操作'}] };
test('difference schema has no scores/winner and rejects invented evidence', () => {
  const result = validateDifference({...major,winner:'A',score_a:5},turn);
  assert.equal(result.material_difference,true);
  assert.equal(result.winner,undefined);
  assert.equal(result.score_a,undefined);
  assert.throws(()=>validateDifference({...major,differences:[{...major.differences[0],answer_a:'凭空编造'}]},turn),{code:'invalid_output'});
  assert.throws(()=>validateDifference({...major,differences:[]},turn),{code:'invalid_output'});
  assert.equal(validateDifference({difference_level:'minor',reason:'表达略不同',differences:major.differences},turn).material_difference,false);
});
test('transient retries never exhaust, malformed/config errors pause',()=>{
  assert.deepEqual([1,2,3,4,1000].map(n=>judgeRetry('network',n)),[60000,300000,900000,3600000,3600000]);
  assert.equal(judgeRetry('configuration',1),null);
  assert.equal(judgeRetry('invalid_output',3,3),null);
});
test('durable retry respects deadline then succeeds and routes exactly once',async t=>{
  let calls=0;
  const f=await fixture(t,{judge:async()=>{
    if(++calls===1) throw Object.assign(Error('offline'),{code:'network'});
    return {...validateDifference(major,turn),model:'test'};
  }});
  const user=await f.add('retry-user');
  const record=await f.turn(user.cookie,'叶片颜色变化如何观察');
  await f.ws.tick('judge');
  let job=await f.repo.get('jobs','judge-'+record.id);
  assert.equal(job.status,'queued');
  assert.equal(job.attempts,1);
  assert(job.next_at>Date.now());
  const reopened=await openRepository({filename:path.join(f.dir,'workspace.sqlite')});
  assert.equal((await reopened.get('jobs',job.id)).next_at,job.next_at);
  await reopened.close();
  await f.ws.tick('judge');assert.equal(calls,1);
  job.next_at=0;await f.repo.put('jobs',job);
  await f.ws.tick('judge');await f.ws.tick('judge');
  assert.equal(calls,2);
  assert.equal((await f.repo.get('jobs',job.id)).status,'completed');
  assert.equal((await f.repo.list('reviews')).length,1);
});
test('restart recovers interrupted judge and orphan job cannot block queue',async t=>{
  const f=await fixture(t);const user=await f.add('restart-user');
  const record=await f.turn(user.cookie,'叶片颜色变化如何观察');
  const job=await f.repo.get('jobs','judge-'+record.id);
  job.status='running';job.attempts=2;await f.repo.put('jobs',job);
  const ws=createWorkspace({repo:f.repo,gateway:{},uploadDir:path.join(f.dir,'uploads'),json(){},readBody(){}});
  await ws.start();await ws.stop();
  const recovered=await f.repo.get('jobs',job.id);
  assert.equal(recovered.status,'queued');assert.equal(recovered.attempts,2);
  assert(recovered.next_at>Date.now());
  recovered.next_at=0;await f.repo.put('jobs',recovered);
  await f.repo.remove('turns',record.id);
  await f.ws.tick('judge');
  assert.equal((await f.repo.get('jobs',job.id)).error.code,'missing_turn');
});
test('configuration changes wake paused comparisons without regenerating answers',async t=>{
  const f=await fixture(t,{judge:async()=>{throw Object.assign(Error('key missing'),{code:'configuration'});}});
  const user=await f.add('config-user');const record=await f.turn(user.cookie);
  await f.ws.tick('judge');
  const before=await f.repo.get('jobs','judge-'+record.id);assert.equal(before.status,'failed');
  const answerBefore=(await f.repo.get('turns',record.id)).candidates;
  const response=await f.request('/models',{judge:{model:'glm-4.7-flash'}},f.admin);
  assert.equal(response.status,200);
  const after=await f.repo.get('jobs',before.id);
  assert.equal(after.status,'queued');assert.equal(after.attempts,0);
  assert.deepEqual((await f.repo.get('turns',record.id)).candidates,answerBefore);
  assert.equal((await f.repo.list('reviews')).length,0);
  assert.equal(f.calls.length,2);
});
test('GLM diff request uses JSON, disables thinking and strips extra score fields',async()=>{
  let payload;
  const gateway=createGateway({JUDGE_BASE_URL:'https://open.bigmodel.cn/api/paas/v4',JUDGE_CLOUD_MODEL:'glm-4.7-flash',JUDGE_API_KEY:'test-only'},null,{fetcher:async(url,o)=>{
    payload=JSON.parse(o.body);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(major)}}]})};
  }});
  const out=await gateway.judge({...turn,context:[],question:'比较'});
  assert.equal(out.difference_level,'major');
  assert.deepEqual(payload.response_format,{type:'json_object'});
  assert.deepEqual(payload.thinking,{type:'disabled'});
});
