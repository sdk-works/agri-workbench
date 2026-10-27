# 前端图片链路 · 交付边界（2026-10-27）

> **版本提示**：本文写于 14:50 那次上线（图片链路，`index-BD_EXos9.js`）。15:18 又上了语音交互改造，生产版本已推进到 **`d27a048` / `index-Cqnwvq3C.js`**，端口、数据库、配置路径、回滚思路都不变，只是产物与提交号变了。语音那轮的记录见 `docs/voice-interaction-report-2026-10-27.md`。

本文回答一个问题：这一轮改动动了哪些文件、跑在哪个实例、走哪些端口、用哪些配置、怎么提交、怎么回滚、有没有碰生产。

## 1. 代码在哪、跑在哪

| 项 | 生产栈 | 隔离栈（本轮开发目标） |
|---|---|---|
| 代码根 | `/home/jingyang/agri-ai/app` | 同一份源码，运行时副本 `/home/jingyang/agri-dev` |
| 服务端代码 | `agri-ai/app/server/` | `agri-dev/server/`（由 `agri-ai/app/server/` 同步，见 §4） |
| 前端源码 | `agri-ai/app/src/` | 同一份（不复制，避免两套源码分叉） |
| 前端产物 | `agri-ai/app/dist/` | `agri-dev/web-dist/` |
| API 端口 | 8787（`agri-workbench.service`） | 8788（`agri-iso.service`） |
| Web 端口 | 8080（`agri-web.service`） | 8099（`agri-iso-web.service`） |
| HTTPS 入口 | 8543（`agri-https.service` → 回源 8080） | 8545（`agri-https-iso.service` → 回源 8099，本轮新增） |
| 数据库 | `agri-ai/data/workspace.sqlite` | `agri-dev/data/iso.sqlite` |
| 上传目录 | `agri-ai/uploads/` | `agri-dev/data/iso-uploads/` |
| 模型配置 | `agri-ai/data/model-config.json` | `agri-dev/data/iso-model.json` |
| 路由策略 | `agri-ai/data/model-policy.json` | `agri-dev/data/iso-policy.json` |
| Git 仓库 | `/home/jingyang/agri-ai`（分支 master） | 同一仓库；`agri-dev` 不是仓库 |

**为什么要隔离栈**：手机上的摄像头/麦克风要求安全上下文（HTTPS 或 localhost）。生产入口现在展示的是线上用户正在用的页面，开发中的改动不能直接替换它。隔离栈有独立数据库、独立上传目录、独立模型配置，改坏了不影响任何人。

## 2. 端口与入口

```
手机/浏览器
  ├─ https://192.168.0.141:8543  → 8080 → 生产（★ 现在用这个，和以前一样）
  ├─ http://192.168.0.141:8080   → 生产（HTTP，摄像头/麦克风会被浏览器拒绝）
  ├─ https://192.168.0.141:8545  → 8099 → 隔离栈（后续开发验证用）
  └─ http://192.168.0.141:8099   → 隔离栈（HTTP，同上）
```

8543（生产）和 8545（隔离）读的是**同一张证书** `deploy/tls/agri.crt`，同一个 `Jingyang Local Root CA` 签发。设备信任过一次，两个端口都不再报警。

8543 经核对实际回源 `8080`（生产），不是隔离栈 —— 之前文档里"8543 = 隔离栈"的说法是错的，本轮修正。

## 3. 配置文件

| 文件 | 作用 | 本轮是否改 |
|---|---|---|
| `agri-ai/data/model-config.json` | 生产角色 → 模型映射（local/fast/vision/fallback…） | 改（视觉角色与能力声明） |
| `agri-ai/data/model-policy.json` | 路由策略（有图走哪个角色、候选池） | 改（视觉默认/备用、必须有图能力） |
| `agri-dev/data/iso-model.json` | 隔离栈的角色映射 | 同步为与生产同构 |
| `agri-dev/data/iso-policy.json` | 隔离栈路由策略 | 新增 |
| `agri-ai/app/server/.env` | 生产环境变量（含 `MODEL_POLICY_PATH`） | 不改 |
| `agri-ai/deploy/tls/` | 本地根 CA 与 leaf 证书 | 不改 |

配置改了要重启对应服务才生效（`systemctl --user restart agri-workbench` / `agri-iso`）。

## 4. 构建与部署

```bash
# 生产前端（本轮不执行）
cd /home/jingyang/agri-ai/app && ./build.sh          # 产物进 dist/

# 隔离栈前端（本轮用这个）
cd /home/jingyang/agri-ai/app && ./build.sh --outDir /home/jingyang/agri-dev/web-dist --emptyOutDir

# 服务端代码同步到隔离栈
rsync -a --exclude='.env*' --exclude='*.bak*' --exclude='*.test.mjs' \
  /home/jingyang/agri-ai/app/server/ /home/jingyang/agri-dev/server/
systemctl --user restart agri-iso
```

`build.sh` 固定了 node 与 vite 路径（系统 PATH 里没有 node），不需要额外记路径。

## 5. 提交与回滚

- 提交：`cd /home/jingyang/agri-ai && git add -A && git commit`（源码、产物、配置模板都进仓库；`data/*.json` 里含密钥的 `model-config.json` 不进）
- 本轮提交：`8ce38df` 「拍照附件全链路：六态状态机、幂等重试、视觉路由硬约束」
- 回滚前端：`git checkout <上一提交> -- app/src app/dist`，或恢复 `agri-dev/web-dist.bak.*`（本轮备份 `web-dist.bak.20261027-143212`）
- 回滚服务端：`git checkout <上一提交> -- app/server`，然后重启服务
- 回滚视觉配置：`data/model-config.json.bak.*`、`data/model-policy.json.bak.*`

## 6. 是否影响生产

**先隔离验证、后上生产**，本轮的顺序是：

1. 14:3x 之前在隔离栈跑完 76 项自动化（不碰生产）
2. 14:43 为确认产物与已提交源码一致，重新构建了一次 `app/dist`（产物 hash 未变：`index-BD_EXos9.js` 189.58 kB / `index-B7d9RenJ.css` 67.25 kB）
3. 14:50 经确认后正式上线，见第 9 节

> 需要说明的一点：第 2 步的构建默认输出目录就是 `app/dist`（生产静态目录），所以**生产前端产物在 14:43 就已经被替换了**，只是当时还没重启 gateway、用户浏览器也还缓存着旧文件。这一步本来应该先 `--outDir` 到临时目录比对、确认无误再落盘，属于操作上的失误。所幸产物与已提交源码完全对应，14:50 的上线把它坐实了，没有造成版本错乱。

生产服务端代码直接从 git 工作区 `agri-ai/app/server` 运行，所以"提交 = 代码就位，重启 = 生效"，没有单独的部署目录。

## 7. 四项状态

| 项 | 状态 | 说明 |
|---|---|---|
| 自动化通过 | **是**（76 项 / 0 失败） | 明细见下表 |
| 真实手机通过 | **待验收** | 需你在棚里操作摄像头/麦克风，清单见第 8 节 |
| 农业图片效果验证 | **部分** | 仅验证了"温室育苗""营业执照"两类图，**没有真实病叶/虫害图**；能"看懂图"已证明，"农业诊断准不准"未证明 |
| 已部署生产 | **是**（2026-10-27 14:50 图片链路 → 15:18 语音改造，当前 `d27a048`） | 见第 9 节；语音那轮的冒烟 18/18 见 `voice-interaction-report-2026-10-27.md` |

### 自动化明细

| 测试 | 项数 | 覆盖 |
|---|---|---|
| `app/src/attach-flow.test.mjs` | 13 | 缩略图≠已上传、无 image_id 算失败、重试沿用幂等键、切会话丢图、本轮引用以服务端编号为准 |
| `app/server/vision-routing.test.mjs` | 7 | 有图但无看图能力时 `roles` 必须为空、深度问题升级/降级路径 |
| `be/iso-image-flow.mjs` | 23 | 跨用户 404、去重、追问沿用同图、换图回答随之改变、切会话 409、9MB/ gif 被拒、取消终态 |
| `fe-v2/camera-e2e.mjs` | 16 | 真实 Chrome + 假摄像头：预览阶段不上传、确认后才上传、"服务器已收到"文案、删除、权限拒绝、不阻塞页面、未捕获异常 |
| `fe-v2/iso-vision-fail.mjs` | 8 | 无视觉模型时 503 不静默退纯文本、上游 404 如实报错、重试落回原轮次（id 不变）、`retry_count=1` |
| `fe-v2/chain-e2e.mjs` | 9 | TTS→ASR（1146ms）→带图模型→回答→TTS，两张不同图答案不同 |

合计 **76 项，全部通过**。

## 8. 真机验收清单（棚里操作，约 8 分钟）

**入口**：手机连棚内 WiFi → 浏览器打开 `https://192.168.0.141:8543`（**和以前一样，没变**）。

关于证书：8543 和 8545 用的是同一个文件 `deploy/tls/agri.crt`、同一个 `Jingyang Local Root CA` 签发，有效期也相同。**设备之前访问 8543 没报警，访问 8545 也不会报警**——CA 装一次就够。只有全新设备才需要装：浏览器打开 `http://192.168.0.141:8099/jingyang-ca.crt`（安卓：设置→安全→安装 CA 证书；iOS：描述文件→安装→再到证书信任设置里打开）。

| # | 操作 | 期望看到 | 不符就是 bug |
|---|---|---|---|
| 1 | 点「语音通话」 | 进入会话，不白屏 | |
| 2 | 点相册，选一张棚里的照片 | 先出预览大图，有「取消 / 用这张 / 重拍」三个按钮 | 若直接上传 = bug |
| 3 | 预览时看附图条文案 | 写"还没上传"，**不能**出现"已上传/服务器已收到" | 出现即 bug |
| 4 | 点「用这张」 | 文案变"上传中"，随后变"服务器已收到，发送问题后开始分析" | 卡在"上传中"超过 10 秒 = bug |
| 5 | 点「重拍」 | 回到取景，重新拍一张，旧的被替换 | |
| 6 | 点删除（×） | 图消失，可以正常打字说话 | 若页面卡住 = bug |
| 7 | 按住说话问"这张图里是什么" | 回答里描述的是**你刚拍的那张图**，不是泛泛而谈 | 答非所问 = bug |
| 8 | 接着说"那这个要怎么处理"（不重新发图） | 回答仍然基于同一张图 | 说"没看到图片" = bug |
| 9 | 换一张完全不同的图再问同样的问题 | 回答跟着新图变 | 答案没变 = bug |
| 10 | 切到另一个会话，再问一句 | 上一条会话的图不跟过来 | 串图 = bug |
| 11 | 第一次进相机时点「拒绝」权限 | 有明确提示，页面仍能正常打字/说话 | 页面卡死 = bug |
| 12 | 飞行模式或断网后点「用这张」 | 提示失败、图还在、有重试按钮 | 图消失 = bug |
| 13 | 恢复网络点重试 | 上传成功，历史里**只有一条**这次的问题 | 出现两条 = bug |

**第 7、9 条是核心**：判断标准只看"回答内容是否真的随图片变化"，不要看界面上有没有图。

## 9. 上生产记录（2026-10-27 14:50）

**做了什么**

1. 备份生产库：`data/workspace.sqlite.bak-deploy-20261027-144830`（34M，用 `sqlite3 .backup` 而非 cp，WAL 模式下才安全）
2. 提交前端产物 `3fa1e69`（`index-BD_EXos9.js` 189.58 kB + `index-B7d9RenJ.css`）
3. `systemctl --user restart agri-workbench`（API 加载新 server 代码）
4. `systemctl --user restart agri-web`（静态站切新产物）
5. 生产冒烟 10/10：临时账号 → 登录 → 上传 → 带图提问 → 同图追问 → 附件 analyzed → 清理，账号数回到 20

**生产实际走的是 30B，不是 7B**：生产 `model-policy.json` 的路由是 `image_default=local`（`qwen3-vl:30b-a3b-instruct`），不是隔离栈用的 7B。冒烟实测回答 317 字，细节比 7B 的 43 字丰富（能说出滴灌带、徒长迹象）。**没有改生产路由**——现有配置能用且效果更好，不为了和隔离栈一致而动生产。

**数据库不需要迁移**：附件信息存在 `turns` 的 body JSON 里，图片本体仍走已有的 `wb_voice_images` 表，没有新表新列。`app/uploads/` 首次上传时自动创建。

**回滚（任一步都能独立回）**

```bash
# 回滚前端产物
cd /home/jingyang/agri-ai && git checkout 3fa1e69^ -- app/dist && systemctl --user restart agri-web

# 回滚服务端代码
cd /home/jingyang/agri-ai && git checkout 8ce38df^ -- app/server && systemctl --user restart agri-workbench

# 回滚数据库（先停服务，否则 WAL 会覆盖回去）
systemctl --user stop agri-workbench
cp data/workspace.sqlite.bak-deploy-20261027-144830 data/workspace.sqlite
rm -f data/workspace.sqlite-wal data/workspace.sqlite-shm
systemctl --user start agri-workbench
```

**隔离栈保留**：8788 / 8099 / 8545 继续跑，后续开发仍优先在隔离栈验证，再上生产。
