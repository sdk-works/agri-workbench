# 青禾 · 农业专家数据工作台 v0.2

本地双模型回答 → 人工独立盲评 → 专家修订 → 独立复审 → SFT / 合格 DPO / 评测集导出。

## 启动

Node.js 24+、npm、Ollama。默认模型为 qwen2.5:7b 与 mistral:7b。

```bash
npm ci
```

首次将 server/.env.example 复制为 server/.env；已有文件不要覆盖。启动 Ollama（已运行则跳过），在两个终端分别执行：

```bash
npm run server
npm run dev -- --port 5174 --strictPort
```

打开 http://127.0.0.1:5174/ 。后端只监听 127.0.0.1:8787；Vite 代理 /api。

## v0.2 的真实功能

- 后端创建持久化任务，固定随机 A/B 映射；候选生成顺序不影响标签。
- 模型来源和裁判结果在人工提交前由服务器隐藏。先选择再启动裁判。
- 两者相当、两者都不好、信息不足均可记录。失败任务保留，不伪装成功。
- 使用 SQLite WAL + FULL synchronous 保存问题、候选、人工选择、修订、复审、审计和导出快照。刷新与重启可恢复。
- 单机生成与裁判串行排队，避免同时加载多个本地模型。重启中断生成会标记失败，不自动重复云端收费请求；已排队裁判恢复处理。
- 同一规范化问题固定 train/eval 分组（约 80/20）。近似问题和同源资料仍需人工分组去重，不能视为完整防泄漏方案。
- SFT 只导出 train 组已复审专家答案；DPO 还要求复审明确确认原始优选回答合格。都差/相当/信息不足不能直接成为 DPO 对。
- eval 导出独立保存，永不混入训练导出。每次导出保存不可变快照及版本 ID。
- 复审人姓名必须不同于标注人和修订人；目前是人工填写的追溯字段，不是身份认证。

## 配置

PRIMARY_MODEL_ROUTE 和 SECONDARY_MODEL_ROUTE 控制两路回答，默认 local_agri / local2_agri。第二路可切至 glm-4.7-flash，必须同时配置智谱 key。

裁判 JUDGE_MODEL=local2_agri 是历史兼容别名，实际调用 LOCAL_MODEL（默认千问），响应记录实际模型。与第一回答同模型存在自评偏差，只作辅助。OpenAI 路由仍为未实现占位函数。

密钥仅放后端 .env 或进程环境，不放 VITE_*。配置页面仍只导出草稿，不修改后端环境。

## 数据与备份

默认数据库在 data/workbench.sqlite，可通过 DATA_PATH 配置绝对路径。数据和密钥均被 Git 忽略。

```bash
npm run backup -- /absolute/backup/workbench-20261009.sqlite
```

备份使用 SQLite 一致性备份接口，可在线运行。脚本读取进程 DATA_PATH（若 .env 配了自定义路径，运行备份前同样设置 DATA_PATH）。备份目标必须不存在。请另外保存至独立设备。

恢复步骤：停止后端，将备份复制到一个新的数据路径，设置 DATA_PATH 指向它并启动；不要在运行时覆盖数据库或只复制 WAL 模式的主文件。

当前 SQLite 是单机试用落地方案，不是多租户生产数据库。后续 PostgreSQL 迁移边界在 server/store.mjs。

## 验证

```bash
npm test
npm run build
node --check server/server.mjs
```

单元/集成测试使用临时数据库和模拟模型，不调用付费 API。测试覆盖 A/B、异步回写、审核条件、导出隔离和备份恢复。浏览器验证说明见 VERIFICATION.md。

## 当前边界

这是受控本机试用版，无正式认证、租户隔离和生产范围拦截，不要直接暴露公网。每条问题独立生成，必要上下文需写在问题中；不自动混用双路历史。原有浏览器内存数据无法追溯恢复，已手动导出的旧文件需另行审核导入。

资料登记、趋势图仍为演示；文件上传、知识检索、Hermes、设备控制、DGX 训练和实际基线跑分尚未实现。前端 Dockerfile 只包含静态页面，不是完整部署。尚未在 DGX ARM64 上验证。

AGRI_PIPELINE_SUMMARY.md 保留归档时的历史发现；已修问题的实现以 v0.2 和 API-CONTRACT.md 为准。
