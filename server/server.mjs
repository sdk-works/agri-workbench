// agri-workbench 模型后端代理 (零依赖, Node 18+)
// 路由: POST /api/v1/chat  ->  local_agri/qwen* -> 本地 Ollama qwen2.5:7b ; glm* -> 智谱 API
//       GET  /api/v1/models -> 模型与连接状态
// 密钥只在此后端环境变量中, 不进浏览器。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.mjs';
import { createPipeline, validateJudge } from './pipeline.mjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 读取配置与密钥: 优先进程环境变量, 其次 server/.env ----
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const env = {};
  try {
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 文件时使用进程环境变量 */ }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
const PORT = Number(ENV.PORT || 8787);
const OLLAMA_BASE = ENV.OLLAMA_BASE || 'http://127.0.0.1:11434';
const LOCAL_MODEL = ENV.LOCAL_MODEL || 'qwen2.5:7b';
const LOCAL2_MODEL = ENV.LOCAL2_MODEL || 'mistral:7b'; // 第二路模型: 可作为云端替身, 保证流程不受云端限流影响
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_DEFAULT_MODEL = 'glm-4.7-flash'; // 官方免费文本模型(输入/输出/缓存均免费)
const JUDGE_MODEL = ENV.JUDGE_MODEL || ZHIPU_DEFAULT_MODEL; // AI 裁判模型(可独立配置; 设 local2_agri 走本地兜底)
const SIMILARITY_THRESHOLD = 0.25; // 回答差异阈值: 低于此值视为"差异大, 自动进评审"（bigram 短文本偏严格, 已调低; 接 embedding 后重校）
const ZHIPU_API_KEY = ENV.ZHIPU_API_KEY || '';
const OPENAI_API_KEY = ENV.OPENAI_API_KEY || ''; // 预留: OpenAI 接入后在此配置

// ---- 基础工具 ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function httpRequest(urlObj, options, body, timeoutMs, onResponse) {
  const lib = urlObj.protocol === 'https:' ? https : http;
  const req = lib.request({
    hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: urlObj.pathname + urlObj.search, method: options.method,
    headers: options.headers,
  }, onResponse);
  req.setTimeout(timeoutMs, () => { req.destroy(new Error('上游请求超时')); });
  req.on('error', (e) => req.destroy(e));
  req.on('error', () => {});
  if (body) req.write(body);
  req.end();
  return req;
}
async function requestJSON(url, { method = 'GET', payload = null, headers = {}, timeoutMs = 120000 } = {}) {
  try {
    const res=await fetch(url,{method,headers:{'Content-Type':'application/json',...(headers||{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(timeoutMs)});
    const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:res.status,data};
  } catch(e) {return {status:0,data:{error:/timeout/i.test(e.name)?'上游请求超时':e.message}}}
}
function postJSON(url, payload, headers = {}, timeoutMs = 120000) {
  return requestJSON(url, { method: 'POST', payload, headers, timeoutMs });
}
function getJSON(url, headers = {}, timeoutMs = 120000) {
  return requestJSON(url, { method: 'GET', headers, timeoutMs });
}

// ---- 模型路由 ----
async function callOllama(messages) {
  const r = await postJSON(`${OLLAMA_BASE}/api/chat`, {
    model: LOCAL_MODEL, messages, stream: false,
  });
  if (r.status !== 200) throw new Error(`本地模型调用失败 (HTTP ${r.status}): ${typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300)}`);
  return { answer: r.data.message?.content ?? '', model: LOCAL_MODEL, provider: 'local', usage: {input_tokens:r.data.prompt_eval_count??null,output_tokens:r.data.eval_count??null} };
}
async function callOllama2(messages) {
  const r = await postJSON(`${OLLAMA_BASE}/api/chat`, {
    model: LOCAL2_MODEL, messages, stream: false,
  });
  if (r.status !== 200) throw new Error(`第二本地模型调用失败 (HTTP ${r.status}): ${typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300)}`);
  return { answer: r.data.message?.content ?? '', model: LOCAL2_MODEL, provider: 'local2', usage: {input_tokens:r.data.prompt_eval_count??null,output_tokens:r.data.eval_count??null} };
}
async function callZhipu(messages, modelName) {
  if (!ZHIPU_API_KEY) throw new Error('未配置 ZHIPU_API_KEY（在 server/.env 中设置）');
  const model = modelName && modelName.startsWith('glm') ? modelName : ZHIPU_DEFAULT_MODEL;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await postJSON(ZHIPU_URL, { model, messages, stream: false },
      { Authorization: `Bearer ${ZHIPU_API_KEY}` }, 90000);
    if (r.status === 200) {
      return { answer: r.data.choices?.[0]?.message?.content ?? '', model: r.data.model || model, provider: 'zhipu', usage: r.data.usage };
    }
    const detail = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    lastErr = new Error(`智谱 API 调用失败 (HTTP ${r.status}): ${detail.slice(0, 300)}`);
    if (r.status === 429 || r.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000)); // 限流/服务端错误: 递增退避重试
      continue;
    }
    throw lastErr; // 其他 4xx 不重试
  }
  throw lastErr;
}

// ---- 云端 provider 抽象: 当前可用=智谱; OpenAI 预留 ----
async function callOpenAI(messages, modelName) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API 未配置。请在 server/.env 添加 OPENAI_API_KEY 后重启后端；当前云端回答使用智谱 glm-4.7-flash');
  }
  const model = modelName && modelName.includes('/') ? modelName.split('/').pop() : (modelName || 'gpt-4o-mini');
  // TODO: 拿到 key 后在此实现 openai chat/completions 调用（与 callZhipu 同构）
  throw new Error(`OpenAI 路由已预留但尚未实现: ${model}（先配 OPENAI_API_KEY）`);
}

// ---- 回答差异度: 字符 bigram Jaccard 相似度 (纯本地零依赖; 有 embedding 后可替换) ----
function charBigrams(text) {
  const s = String(text || '').replace(/\s+/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
function textSimilarity(a, b) {
  const A = charBigrams(a), B = charBigrams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- AI 裁判: 盲评 A/B 并打分 (LLM-as-judge, 默认智谱, 可配 JUDGE_MODEL) ----
async function callJudgeOnce({ question, answerA, answerB }) {
  const system = '你是农业领域专家评审。下面给你同一个农业问题的两个候选回答（编号 A 与 B），来源已隐藏，请完全忽略表达风格差异，按以下标准独立打分（每项 1-5 分）：准确性（事实是否正确）、完整性（是否覆盖问题关键点）、可执行性（建议能否直接落地）、简洁性（无冗余）。然后给出结论：A 更好 / B 更好 / 两者相当。只输出 JSON，格式：{"a_accuracy":n,"a_completeness":n,"a_actionable":n,"a_concise":n,"b_accuracy":n,"b_completeness":n,"b_actionable":n,"b_concise":n,"winner":"A"|"B"|"tie","reason":"一句话理由"}';
  const user = `【问题】${question}\n\n【候选回答 A】\n${answerA}\n\n【候选回答 B】\n${answerB}`;
  let r;
  if (String(JUDGE_MODEL).startsWith('local2')) {
    // 裁判走本地指令遵循更强的模型(qwen2.5:7b)，云端限流时兜底，保证评审流程可用
    r = await postJSON(`${OLLAMA_BASE}/api/chat`, { model: LOCAL_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, options: {temperature: 0.2}, format: 'json' }, null, 90000);
  } else {
    r = await postJSON(ZHIPU_URL, { model: JUDGE_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, temperature: 0.2 },
      { Authorization: `Bearer ${ZHIPU_API_KEY}` }, 90000);
  }
  if (r.status !== 200) {
    const detail = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    throw new Error(`裁判模型调用失败 (HTTP ${r.status}): ${detail.slice(0, 300)}`);
  }
  const text = String(JUDGE_MODEL).startsWith('local2')
    ? (r.data.message?.content ?? '')   // Ollama 结构
    : (r.data.choices?.[0]?.message?.content ?? ''); // 智谱/OpenAI 结构
  let parsed = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 容错 */ } }
  if (!parsed || !['A', 'B', 'tie'].includes(parsed.winner)) {
    throw new Error(`裁判输出无法解析: ${text.slice(0, 300)}`);
  }
  return {...validateJudge(parsed),judge_model:String(JUDGE_MODEL).startsWith('local2')?LOCAL_MODEL:JUDGE_MODEL,judge_route:JUDGE_MODEL,provider:String(JUDGE_MODEL).startsWith('local2')?'local':'zhipu'};
}
async function callJudge({ question, answerA, answerB }) {
  if (!ZHIPU_API_KEY && !String(JUDGE_MODEL).startsWith('local2')) throw new Error('未配置 ZHIPU_API_KEY，AI 裁判不可用');
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await callJudgeOnce({ question, answerA, answerB }); }
    catch (e) {
      lastErr = e;
      const limited = /429|500|502|503|超时|无法解析/.test(e.message);
      if (limited && attempt < 3) { await new Promise((resolve) => setTimeout(resolve, attempt * 2500)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length) return json(res, 400, { error: 'messages 不能为空' });
  if (messages.some((m) => !m || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string')) {
    return json(res, 400, { error: 'messages 格式不正确' });
  }
  const requested = String(body.model || '');
  const isLocal = requested.startsWith('local_') || /qwen/i.test(requested);
  const isLocal2 = requested.startsWith('local2');
  const isCloudZhipu = requested.startsWith('glm');
  const isOpenAI = requested.startsWith('openai') || /^gpt-/i.test(requested);
  if (!isLocal && !isLocal2 && !isCloudZhipu && !isOpenAI) return json(res, 400, { error: `未知模型: ${requested}（支持 local_agri/qwen* 本地, local2_agri 第二本地, glm* 智谱, openai/gpt* 预留）` });
  try {
    const out = isLocal ? await callOllama(messages) : (isLocal2 ? await callOllama2(messages) : (isOpenAI ? await callOpenAI(messages, requested) : await callZhipu(messages, requested)));
    return json(res, 200, {
      request_id: crypto.randomUUID(),
      answer: out.answer,
      model: out.model,
      provider: out.provider,
      citations: [],
      usage: out.usage,
    });
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}

async function handleSimilarity(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const a = String(body?.text_a ?? '').trim();
  const b = String(body?.text_b ?? '').trim();
  if (!a || !b) return json(res, 400, { error: 'text_a 与 text_b 不能为空' });
  const score = textSimilarity(a, b);
  return json(res, 200, {
    score: Number(score.toFixed(4)),
    threshold: SIMILARITY_THRESHOLD,
    verdict: score >= SIMILARITY_THRESHOLD ? 'similar' : 'different',
    note: '字符 bigram Jaccard 相似度（0-1）；接入 embedding 后可替换为语义相似度',
  });
}

async function handleJudge(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const question = String(body?.question ?? '').trim();
  const a = String(body?.answer_a ?? '').trim();
  const b = String(body?.answer_b ?? '').trim();
  if (!question || !a || !b) return json(res, 400, { error: 'question / answer_a / answer_b 不能为空' });
  try {
    const verdict = await callJudge({ question, answerA: a, answerB: b });
    return json(res, 200, verdict);
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}

async function handleModels(req, res) {
  const list = [];
  // 本地 Ollama 状态
  let localOk = false; let installed=[];
  try {
    const r = await getJSON(`${OLLAMA_BASE}/api/tags`, {}, 5000);
    localOk = r.status === 200; installed=(r.data.models||[]).map(m=>m.name);
  } catch { localOk = false; }
  list.push({ id: 'local_agri', name: `本地千问 (${LOCAL_MODEL})`, provider: 'local', capability: ['chat'], connected: localOk&&installed.includes(LOCAL_MODEL), note: localOk ? (installed.includes(LOCAL_MODEL)?'已安装 · 推理时再验证':'模型未安装') : 'Ollama 未响应' });
  list.push({ id: 'local2_agri', name: `第二本地模型 (${LOCAL2_MODEL})`, provider: 'local2', capability: ['chat'], connected: localOk&&installed.includes(LOCAL2_MODEL), note: localOk ? (installed.includes(LOCAL2_MODEL)?'已安装 · 推理时再验证':'模型未安装') : 'Ollama 未响应' });
  // 智谱状态
  list.push({ id: ZHIPU_DEFAULT_MODEL, name: `智谱 (${ZHIPU_DEFAULT_MODEL})`, provider: 'zhipu', capability: ['chat'], connected: false, configured:Boolean(ZHIPU_API_KEY), note: ZHIPU_API_KEY ? '密钥已配置 · 连通性未验证' : '未配置密钥' });
  return json(res, 200, { models: list });
}

const store=new Store(ENV.DATA_PATH || path.join(__dirname,'../data/workbench.sqlite'));
const pipeline=createPipeline({store,first:ENV.PRIMARY_MODEL_ROUTE||'local_agri',second:ENV.SECONDARY_MODEL_ROUTE||'local2_agri',
  generate:async(route,messages)=>route==='local_agri'?callOllama(messages):route==='local2_agri'?callOllama2(messages):route.startsWith('glm')?callZhipu(messages,route):callOpenAI(messages,route),
  judge:callJudge,
  similarity:(a,b)=>{const score=textSimilarity(a,b);return {score,threshold:SIMILARITY_THRESHOLD,verdict:score<SIMILARITY_THRESHOLD?'different':'similar',method:'char-bigram-jaccard-v1'}}
});
pipeline.recover();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return json(res,403,{error:'仅允许本机开发页面访问'})}catch{return json(res,403,{error:'无效来源'})}}
    if(req.method==='POST' && !String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'需要 application/json'});
    if(req.method==='GET'&&url.pathname==='/api/v1/comparisons')return json(res,200,{items:pipeline.list()});
    if(req.method==='POST'&&url.pathname==='/api/v1/comparisons')return json(res,202,pipeline.create(await readBody(req)));
    const match=url.pathname.match(/^\/api\/v1\/comparisons\/([\w-]+)(?:\/(choice|revision|approve|exclude))?$/);
    if(match){const [,id,action]=match;if(req.method==='GET'&&!action)return json(res,200,pipeline.get(id));if(req.method==='POST'&&action){const body=await readBody(req);const method={choice:'vote',revision:'edit',approve:'approve',exclude:'exclude'}[action];return json(res,200,pipeline[method](id,body))}}
    if(req.method==='POST'&&url.pathname==='/api/v1/datasets/export'){const body=await readBody(req);return json(res,200,pipeline.exportDataset(body.kind))}
    if (req.method === 'POST' && url.pathname === '/api/v1/chat') return await handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/similarity') return await handleSimilarity(req, res);
    if (req.method === 'POST' && url.pathname === '/api/v1/judge') return await handleJudge(req, res);
    if (req.method === 'GET' && url.pathname === '/api/v1/models') return await handleModels(req, res);
    if (req.method === 'GET' && url.pathname === '/api/v1/health') return json(res, 200, { ok:true,version:'0.2.0',storage:'sqlite',localModel:LOCAL_MODEL,secondaryRoute:ENV.SECONDARY_MODEL_ROUTE||'local2_agri',zhipuConfigured:Boolean(ZHIPU_API_KEY) });
    return json(res, 404, { error: 'Not Found' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`模型后端代理已启动: http://127.0.0.1:${PORT}`);
  console.log(`本地模型: ${LOCAL_MODEL} @ ${OLLAMA_BASE} | 智谱: ${ZHIPU_API_KEY ? '密钥已配置' : '未配置密钥'}`);
});
