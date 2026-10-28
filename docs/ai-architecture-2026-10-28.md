# 京阳智农 · AI 农业工作台 — 架构与调试记录

> 记录时间：2026-10-28 14:00（Asia/Shanghai）
> 生产环境：本地 Ubuntu `jingyang@141`（内网 192.168.0.141），公网经云服务器 `42.193.104.148` 中转
> 本文对应当前线上代码：`app/src/WorkspaceApp.vue` 7251 行、`app/server/workspace.mjs` 3275 行、安卓壳 v1.11

---

## 一、系统定位

面向温室种植园区的 AI 问答与生产辅助平台。核心是"一部手机在现场，用嘴问、用摄像头给看，AI 给判断"，
外加团队管理、资料库、配图生成、回答评审等后台能力。

三条主链路：

| 链路 | 入口 | 特点 |
|---|---|---|
| 文字问答 | `/` 工作台 → `POST /api/v2/turns` | 一轮可有多个候选答案，可采纳、可反馈 |
| 语音通话 | 工作台浮层 → `POST /api/v2/voice/turn`（SSE） | 边说边听、边生成边播、可打断 |
| 随问附图 | `/api/v2/voice/image` 上传 → 轮次带 `image_id` | 图片只进入该轮，不长期驻留历史 |

---

## 二、部署拓扑

```
                       ┌──────────────────────────────┐
   手机 App / 浏览器    │  Cloudflare Edge (sundaokun.eu.cc)
                       └──────────────┬───────────────┘
                                      │ 命名隧道（token）
                       ┌──────────────▼───────────────┐
                       │ 云服务器 42.193.104.148       │
                       │  cloudflared → 127.0.0.1:8080 │
                       │  frps  监听 7000 / 443 / 8080 │
                       │  （80 端口被 IoT 云程序占用） │
                       └──────────────┬───────────────┘
                                      │ frp（token 认证）
                       ┌──────────────▼───────────────┐
                       │ 本地主机 192.168.0.141        │
                       │  frpc                         │
                       │   ├ 8080 → gateway.mjs :8080  │
                       │   └ 443  → https-proxy :8544  │
                       └──────────────┬───────────────┘
                                      │
                  ┌───────────────────┼────────────────────┐
                  ▼                   ▼                    ▼
        gateway.mjs :8080      server.mjs :8787      voice_service :8790
        静态 dist + /api 反代    业务 API + 模型网关     Whisper + Edge TTS
                                      │
                                      ▼
                            Ollama :11434（本地大模型）
                            + 云端 API（OpenAI / 智谱）
```

三个对外入口：

| 入口 | 链路 | 用途 |
|---|---|---|
| `http://42.193.104.148:8080/` | frps 8080 直通 | **App 主入口**，国内移动网络秒开 |
| `https://sundaokun.eu.cc/` | Cloudflare → frps 8080 | 安全上下文入口，域名证书自动续期 |
| `https://42.193.104.148/` | frps 443（PROXY v2）→ 8544 | 自签 CA 入口，需手机装根证书 |

> 为什么 App 主入口是 http：App 是纯 WebView 壳，语音走**壳内原生桥**（录音 + 原生 TTS），
> 不依赖 `getUserMedia`，所以 http 是非安全上下文并不影响语音；只有"页内相机"才必须要安全上下文，
> 这一条已经在 v1.11 改成直接拉起系统相机。域名入口在国内移动网络上有 8 秒级握手问题，故降为备用。

---

## 三、运行时组件

| 服务（systemd --user） | 代码位置 | 端口 | 职责 |
|---|---|---|---|
| `agri-workbench` | `app/server/server.mjs` | 127.0.0.1:8787 | 业务 API、模型网关、SSE |
| `agri-web` | `deploy/gateway.mjs` | 0.0.0.0:8080 | 静态资源 + `/api` 反代 + http→https 301 |
| `agri-voice` | `voice_service.py` | 127.0.0.1:8790 | ASR（faster-whisper）+ TTS（edge-tts） |
| `agri-ollama` | `runtime/ollama/bin/ollama` | 127.0.0.1:11434 | 本地大模型推理 |
| `frpc` | `/usr/local/bin/frpc` | — | 内网穿透客户端 |
| `agri-https` / `agri-https-iso` | `deploy/https-proxy.mjs` | 8543 / 8544 | 自签 TLS 终结 |
| `agri-iso*` | `~/agri-dev/` | 8099 | 隔离的开发副本，用于试验 |

云服务器（`jycloud`）：

- `cloudflared`（systemd system 服务，`/etc/cloudflared/token`）
- `frps`（`/etc/frp/frps.toml`，`bindPort = 7000`）
- 静态 APK 目录：`/var/www/greenhouse/apk/`

---

## 四、模型层

### 4.1 角色 → 模型（`data/model-config.json`）

| 角色 | 模型 | 端点 |
|---|---|---|
| `local`（主力） | `qwen3-vl:30b-a3b-instruct` | 127.0.0.1:11434 |
| `fast` | `qwen3-vl:30b-a3b-instruct` | 127.0.0.1:11434 |
| `vision` | `qwen2.5vl:7b` | 127.0.0.1:11434 |
| `fallback` | `orcarouter/Qwen3.8-27B-Uncensored` | 127.0.0.1:11434 |
| `cloud` | `gpt-5` | api.openai.com |
| `judge` | `glm-4.7-flash` | open.bigmodel.cn |

### 4.2 路由策略（`data/model-policy.json`，改配置不改代码）

- `image_default` / `image_deep` / `image_pool` = `local`：**带图请求一律走本地视觉模型**，不外传。
- `text_fast` = `fast`，`text_strong` = `local`，`cloud_fallback` = `cloud`。
- 深度信号：`deep_keywords`（诊断/病因/防治/病害…）+ `deep_min_length = 25`。
- 采样：默认 `temperature 0.5`，JSON 场景 `0.1`。

### 4.3 提示词分层

`BASE_RULES`（农业园区助手身份）→ `IMAGE_RULES`（带图时的看图纪律）→ 参考资料 → 本轮原话回指。
关键约束（都是踩坑后加的）：

- 没有实时数据源，**不许给具体温湿度/天气/价格数字**；
- "信息不足先问"分成两层：通用规律先讲，个案判断先问；
- "无法确认"只能用于某一个具体判断，不能代替整段回答；
- 2026-10-28 新增：**招呼、试麦、听不清的零碎字**用一句话回应并请对方讲问题，不许套"无法确认"三段式。

---

## 五、数据层

SQLite 单库 `data/workspace.sqlite`，仓储层 `repository.mjs` 做了"文档型"封装（每行 `id + body JSON`）。

主要表（27 张）：

```
wb_users / wb_departments / wb_sessions        账号、部门、会话令牌
wb_conversations / wb_turns                    会话与轮次（轮次含 candidates[]、image、image_attachment）
wb_voice_images                                随问附图（id/归属/状态/落盘路径）
wb_jobs / wb_image_jobs                        生成任务队列
wb_reviews / wb_review_versions / wb_annotations  回答评审与标注
wb_assets / wb_documents / wb_document_versions   资料库
wb_feedback / wb_events / wb_settings          反馈、审计、配置
wb_block_rules                                 内容拦截规则
```

文件存储：`uploads/voice-images/<tenant>/<owner>/<image_id>.jpg`（权限 0600），限 8 MB，仅 JPG/PNG/WEBP。

### 上下文口径（重要，用户常问）

- 文字与语音**共用 `conversation_id`**；语音进入时继承当前文字会话（2026-10-28 修）。
- 后端取 `turns.slice(-10)`，每轮压成"用户问题 + 采用/完整的答案"纯文本；累计超 **50000 字符**提示新建会话。
- **图片不进历史**：历史只传文字；只有本轮 `image_id` 作为视觉输入。
  同一通对话内图未删则下轮自动复用；`startCall` 会清图，跨通话失效。
  （试过"追问不再送图、靠历史承接"，模型没依据还硬答，故放弃。）

---

## 六、语音链路

### 6.1 服务端

`voice_service.py`（Python，290 行）：

- ASR：`faster-whisper`，模型 `small`，8 线程，带农业词表 `initial_prompt` 偏置。
- TTS：微软 `edge-tts`，默认 `zh-CN-XiaoxiaoNeural`。
- **合成重试**（2026-10-28 加）：同一句最多 4 次 `[(音色,0),(音色,.25),(音色,.5),(默认音色,.4)]`，
  空音频与异常都重试，全失败才抛错——因为上游会间歇性返回 `NoAudioReceived`。

### 6.2 前端播放队列

| 参数 | 值 | 说明 |
|---|---|---|
| `VOICE_FIRST_SENTENCE` | 12 字 | 首句阈值，保证第一声快出来 |
| `VOICE_MIN_SENTENCE` | 32 字 | 后续句阈值，减少切换次数 |
| `TTS_PREFETCH_AHEAD` | 3 句 | 播当前句时后面 3 句已在合成 |
| `VOICE_ASR_MS` | 20 s | 识别超时 |
| `VOICE_FIRST_TOKEN_MS` | 35 s | 首字超时 |

播放链关键设计：

- **切句规则**：取"第一个使长度达阈值的句末标点"，不是第一个标点。
  （错误写法：切完太短塞回队首 → 队首永远长不大，整段憋到流结束才合成，首音反而更慢。）
- **打断**：用户开口即停（`startBargeIn`），迟到的旧答案按 `voiceEpoch` 丢弃，防止隔轮串音。
- **兜底看门狗**：本机朗读 15 秒无回调强制解锁，避免 `voiceSpeakResolve` 永挂。

### 6.3 安卓壳原生桥

`window.QingHeVoice`：`recStart / recStop / speak / diagnose`。
录音与朗读都在壳内完成（MediaRecorder + `TextToSpeech`），网页只负责上传音频、拿文本、合成音频播放。

---

## 七、前端

- Vue 3 `<script setup>` 单文件：`app/src/WorkspaceApp.vue`（7251 行，含模板/逻辑/样式）。
- 构建：`app/build.sh` → `runtime/node` + `toolchain/vite` → `dist/`。
  产物需回填 `ca.html`、`entry.html`、`jingyang-ca.crt`（`/tmp/dist-keep` 备份）。
- 附图状态机独立成 `src/attach-flow.mjs` + 单测：`picked → uploading → received → analyzing → done / failed`。
- 移动端断点：760 px（侧栏抽屉）、900 px（团队/组织单列）、1100 px（问答双栏收窄）。

---

## 八、安卓壳

- 本质是**纯 WebView 壳**，无 assets，页面全在服务端。
- `HOME_URL = http://42.193.104.148:8080/`（主）、`FALLBACK_URL = https://sundaokun.eu.cc/`（备）
- `LOAD_TIMEOUT_MS = 8000`，主入口超时自动切备用；两级都失败显示可点重试的红条。
- `isInternalUrl()` + `matchesHost()` 精确白名单：新域名、旧 IP、`qinghe.local`。
- 拍照：`onShowFileChooser` 识别 `capture` → `ACTION_IMAGE_CAPTURE` + `ShotProvider`（`com.qinghe.app.shot`）；
  无相机权限先申请，拒绝则退回相册并 Toast 说明。
- OTA：`/var/www/greenhouse/apk/agri-android.json` 比对 `versionCode`。
- 构建链（不打 Gradle）：`aapt2 compile/link` → `javac -source 8 -target 8` → `d8 --min-api 21` → `zipalign -p 4` → `apksigner sign`。
- 签名：`~/agri-keystore/qinghe.jks`，alias `qinghe`，SHA-256 `d7931658…dc6a`，30 年有效期。
  **这个文件丢了，以后每次发版都要用户卸载重装。**

---

## 九、安全与权限

| 机制 | 位置 | 说明 |
|---|---|---|
| 来源白名单 | `server.mjs` + `origin-guard.mjs` | `ALLOWED_ORIGINS`，**每换一个入口都要同步**，已踩坑三次 |
| 登录态 | `wb_sessions` + HttpOnly Cookie | 图片、语音接口均校验 |
| 角色 | employee / expert / manager / admin | + `scope_all` 控制跨部门 |
| 回答守卫 | `answer-guard.mjs` | 拦截危险/违规表述 |
| 内容规则 | `wb_block_rules` | 正则或关键词，命中即 block/flag |
| 图片访问 | `loadVoiceImage` | 只允许上传者本人，跨用户一律 404 |

---

## 十、调试记录（按时间倒序）

### 2026-10-28（下午）· 第四轮

| 现象 | 根因 | 改法 |
|---|---|---|
| 一开始喊"喂喂喂"，AI 直接回"你这情况我无法确认" | 招呼被当成正式问题送进模型，命中提示词里"不确定先说无法确认"的规则 | 前端 `chitChatReply()` 在 `askStreaming` 入口拦截（不建轮次、不调模型，只回一句"我在，您说"）；`BASE_RULES` 增加招呼处理规则 |
| 手机上传的图在对话记录里看不到 | `safeTurn` 已返回 `image.attachment_id`，但问答模板从未渲染 | 问题气泡下加缩略图按钮，点开全屏看原图（`/api/v2/voice/image/:id`；该接口早已存在但前端没用过） |
| 手机上"团队提问"看不到详细对话 | ≤900 px 时列表与详情改成单列，详情被挤到列表下方，很容易看漏 | 选中会话后详情整屏铺开（fixed），顶部加"← 返回列表" |

### 2026-10-28（中午）· 第三轮

- **句号间隔长**：不是音频问题，是切句太碎（一句二三十字，每段尾部还带静音）。
  先改成"首句 12 字 / 后续 32 字"，中间试过两个错误写法（切短了塞回队首、`while(len>=min)` 取第一个标点），
  都是**恒等于无效**——队首短句长度不变，永远长不大。最终按 `m.end() >= minLen` 选切口，预制提到 3 句。
- **拍照后卡住无提示**：新增全屏遮罩，`已打开相机…` → `正在处理照片…`，压缩完才撤。
- **语音和文字前后不搭**：`startCall()` 原本清空会话号；改为继承当前文字会话，语音新会话也回写文字界面。
- **「文字」按钮**：两轮才对齐语义 —— 用户要的是**切换字幕显示**，不是挂断。

### 2026-10-28（上午）· 第二轮

- **"中文朗读引擎不可用"**：`edge-tts` 间歇返回空音频 → `POST /tts 500 NoAudioReceived` → 前端退回本机朗读 → 手机无中文引擎 → 红字。
  服务端加重试；前端不再把兜底失败甩红字；补 15 秒看门狗解开播放链。
- **"文字按钮失效"**：真凶是 `busy` 时整个输入区灰掉；改为发送键只在未输入时禁用，忙碌时给明确提示。

### 2026-10-28（凌晨）· v1.8 → v1.11

| 版本 | 问题 | 处理 |
|---|---|---|
| v1.8 | 白屏 | 未处理 `onReceivedSslError`、无加载超时 |
| v1.9 | 等 8 秒才开、提示"来源未授权" | 加载状态条 + 8 s 超时 + SSL 回调；补 `ALLOWED_ORIGINS` 公网 IP |
| v1.10 | 域名在移动网络 8 秒不通 | 主入口改回 IP，域名作备用 |
| v1.11 | 点拍照只弹相册 | `params.createIntent()` 默认是 `ACTION_GET_CONTENT`，**完全忽略网页 `capture` 标记**；改为自建 `ACTION_IMAGE_CAPTURE` + `ShotProvider` |

同时修掉一个长期隐患：`build.sh` 里 `rm -rf $WORK` 会连签名密钥一起删掉再重建，
导致每个包的签名都不一样（永远无法覆盖安装）。改为引用 `~/agri-keystore/qinghe.jks`，缺失直接 `exit 1`。

### 2026-10-27 · 公网接入

- `sdkworks.cloud-ip.cc` 不可用：ClouDNS 免费子域不允许改 NS、有 302 停放、拿不到证书。
- 改用 GNAME 的 `sundaokun.eu.cc`（免费一年，可自定义 NS）→ Cloudflare 命名隧道。
- `cloudflared tunnel login` 拉证书被阻断 → 改为面板建隧道 + token 装服务。
- 面板缺 Public Hostname → 无 CNAME；补 route（Type=HTTP，URL=`127.0.0.1:8080`）。
- 登录 403「页面来源未授权」→ `ALLOWED_ORIGINS` 三次补入（域名、局域网 IP、公网 IP）。
- 曾给 `42.193.104.148:8080` 加 301 跳域名，结果 App 被甩到系统浏览器（壳的 URL 白名单不含域名）→ **已回退**。

---

## 十一、已知问题与待办

1. **签名密钥未异地备份** —— `~/agri-keystore/qinghe.jks`（口令 `qinghe123456`）。丢失即永久失去覆盖安装能力。
2. **壳层兜底朗读仍可能静音** —— 本机 TTS 只试 `Locale.SIMPLIFIED_CHINESE` 一级，缺中文数据时无声（现在只是不再弹红字）。
   下一版壳应改多级 locale + pending 队列。
3. **团队视图看不到他人会话的附图** —— 图片接口按 `owner` 校验，管理员查看他人图片会 404。需要后端加 `scope=team` 授权分支。
4. **生产代码未回传仓库** —— GitHub `sdk-works/agri-workbench` 仍是 5090 行版本，线上 `WorkspaceApp.vue` 已 7251 行。
5. **`sundaokun.eu.cc` 2027-01-26 到期**，免费域名需提前 90 天续。
6. **`jyaigreenhouse.com` 备案通过后**切境内 443：需同步 `ALLOWED_ORIGINS`，并把 App 主入口换成域名。
7. **上下文只有 10 轮**、图不入历史，长会话会被截断（有 50000 字符上限保护）。

---

## 十二、运维速查

```bash
# 看服务
systemctl --user status agri-workbench agri-web agri-voice
journalctl --user -u agri-voice -n 100 --no-pager
journalctl --user -u agri-workbench -n 200 --no-pager | grep -i error

# 改前端 → 构建 → 回填附加页（顺序不能反）
cd ~/agri-ai/app && ./build.sh
cp /tmp/dist-keep/ca.html /tmp/dist-keep/entry.html /tmp/dist-keep/jingyang-ca.crt dist/

# 改后端 → 重启（改 .mjs 才需要）
systemctl --user restart agri-workbench

# 语音服务
systemctl --user restart agri-voice && curl -s http://127.0.0.1:8790/health

# 自检
curl -s http://127.0.0.1:8787/api/v1/health
curl -s http://127.0.0.1:8790/health
curl -sI https://sundaokun.eu.cc/

# 数据库（只读查看）
sqlite3 ~/agri-ai/data/workspace.sqlite '.tables'

# 安卓构建（云服务器）
ssh jycloud; cd ~/agri-android-src && bash build.sh
sudo cp ~/android-build/out/jingyang-1.11.apk /var/www/greenhouse/apk/jingyang-v1.11.apk
```

备份优先级：`~/agri-keystore/qinghe.jks` > `data/workspace.sqlite` > `app/src/*.vue` > `app/server/*.mjs`。

---

## 十三、目录速查

```
~/agri-ai/
├─ app/
│  ├─ src/WorkspaceApp.vue        前端主界面（7251 行）
│  ├─ src/attach-flow.mjs         附图状态机（带单测）
│  ├─ server/server.mjs           入口 + 路由分发
│  ├─ server/workspace.mjs        业务核心（3275 行）
│  ├─ server/model-gateway.mjs    模型路由
│  ├─ server/voice.mjs            语音 HTTP 层（555 行）
│  ├─ server/image-server.mjs     配图任务
│  └─ dist/                       线上静态产物
├─ deploy/gateway.mjs             静态 + 反代 + https 301
├─ voice_service.py               ASR + TTS（290 行）
├─ data/workspace.sqlite          主库
├─ data/model-config.json         模型角色
├─ data/model-policy.json         路由与采样
├─ uploads/voice-images/          随问附图
└─ docs/                          既有文档
```

云服务器：`~/agri-android-src/`（安卓源码）、`~/android-sdk/`、`/var/www/greenhouse/apk/`（APK 与 OTA 清单）。
