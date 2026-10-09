# 青禾 · 农业 AI 工作台

## 当前后端版本（2026-10-09 更新）

已增加零依赖 Node 后端：Ollama 双模型、智谱调用、字符相似度、AI 裁判与前端 DPO 导出。当前为本机开发原型，无正式登录、持久化和训练服务。下文“本版范围”及旧验证文档描述的是早期纯前端版本。

详见 [最新交接与已知问题](AGRI_PIPELINE_SUMMARY.md)。正式采集前优先修复 A/B 显示映射和异步结果竞态。

1. `npm ci`，准备 Ollama 的 `qwen2.5:7b` 和 `mistral:7b`。
2. 将 `server/.env.example` 复制为 `server/.env` 并配置；已有文件不要覆盖。
3. 启动 Ollama（若已运行则跳过），独立终端执行 `node server/server.mjs`。
4. 另一终端执行 `npm run dev -- --port 5174 --strictPort`，打开 http://127.0.0.1:5174/ 并切换到后端模式。

Vite 将 `/api` 代理到本机 8787。第二路目前调用本地 mistral；OpenAI 仍是占位函数，设置 key 后也需要补充实现。裁判 `local2_agri` 实际调用第一本地模型千问。

前端 Dockerfile 仅构建静态页面，不包含后端或 API 反向代理，不是完整生产部署。后端仅监听本机，不能直接用于公网服务。密钥只保存在后端 .env 或进程环境变量中。

---

本地部署优先的 Vue 3 Web 原型。青禾为暂定展示名称，可替换。

## 启动

需要 Node.js 22+ 和 npm。在项目目录执行：

```bash
npm ci
npm run dev
```

使用终端输出的本机地址。生产构建：`npm run build`，产物在 `dist/`。
预览构建：`npm run preview`。不要通过双击 index.html 运行 Vue 源码。

## 本版范围

- 工作台、农业问答、双模型评审、知识资料、模型训练、模型中转六个页面。
- 演示问答使用预置文本，不调用模型；切换后端模式才调用 `/api/v1/chat`。
- 专家选择、修订、待复审、审核、示例 SFT JSONL 导出可操作。
- 文件登记只读取名称、大小等信息，**不上传或保存文件正文**。
- 网关配置草稿可校验和导出；不测试供应商连接、不保存密钥。
- 所有业务修改只存在于当前页面内存，刷新重置；不是正式持久化系统。
- 未实现真实登录、权限、数据库、Hermes、检索、模型调用与训练。
- 趋势图与初始任务为明确标注的示意数据；导出记录包含 `demo: true`。

## DGX 部署

DGX Spark 使用基于 Ubuntu 的 DGX OS，CPU 为 ARM64。
前端可以在兼容 ARM64 的 Node 环境构建，也可在其他开发机构建后复制静态产物。
项目提供前端 Dockerfile；基础镜像须在目标环境确认 ARM64 可用性。

```bash
docker build -t agri-workbench:0.1 .
docker run --rm -p 127.0.0.1:8080:80 agri-workbench:0.1
```

这是仅前端的本机预览。正式局域网服务需增加认证、TLS/安全访问及同源 API 反向代理。
没有在本次开发环境实际执行 DGX/ARM64 容器验证。

## 后端边界

`src/api.js` 是业务 API 适配层，统一访问 `/api/v1`，不是云端模型直连客户端。
模型供应商密钥仅在后端环境变量中设置。`VITE_*` 会进入浏览器，不得放置密钥。
接口契约见 `API-CONTRACT.md`。

后续接入顺序：身份与权限 → PostgreSQL 持久化 → 模型网关 → 资料与知识检索 → Hermes → DGX 训练评测。
