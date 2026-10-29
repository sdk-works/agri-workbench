# 京阳智农 · 农业 AI 工作台

给农业场景做问答与知识沉淀的内部工作台：员工提问 → 本地/云端双回答 + 独立裁判 → 规则分流 → 领域专家确认 → 审核数据集。附带资料清洗入库、图片提问、语音问答、可追溯资产包与安卓客户端。

> 产品功能与运维细节见 **[app/README.md](app/README.md)**，这里只做仓库总览。

## 目录

| 目录 | 内容 |
|---|---|
| `app/` | 主体。前端 Vue（`src/`）、后端 Node（`server/`）、构建产物（`dist/`），以及 [产品与运维说明](app/README.md) |
| `android/` | 安卓 WebView 壳（加载服务端页面 + 静默更新），含手写构建脚本 `build.sh`，见 [安卓端说明](app/README.md#安卓端apk) |
| `deploy/` | 生产网关 `gateway.mjs`（静态直出 + API 反代）、HTTPS 反代 `https-proxy.mjs`、证书（私钥不入库） |
| `docs/` | 架构、语音交互、移动端接入、证书与麦克风配置等专题文档 |
| `voice_service.py` | 本地语音服务（ASR/TTS） |

## 运行形态

生产不是容器，是三个 systemd 进程：

```
手机 / 浏览器
   │  HTTPS 443（云服务器 frps，只做端口转发）
   ▼
frpc 回源 → 本地 8544 https-proxy.mjs（终止 TLS）
              │
              ▼  8080 gateway.mjs ── 直出前端产物 app/dist
                    │
                    ▼  8787 server.mjs ── 业务与 API、SQLite、Ollama
```

云服务器只承担端口转发，业务数据、模型、数据库都在本地机器上。

## 快速开始

```bash
cd app
npm ci
npm run server        # 后端，默认 127.0.0.1:8787
npm run dev           # 前端开发服务器
```

首次运行把 `app/server/.env.example` 复制成 `app/server/.env`，打开页面后创建管理员账号。本地推理需要 Ollama；云端模型与裁判在「模型与规则」里配置。完整步骤见 [app/README.md](app/README.md#本地开发)。

## 更新方式

- **改界面、改业务**：重新构建前端产物或重启后端即可，用户刷新页面就是新版，**不用发 APK**。
- **改壳**（首页地址、权限、证书信任、更新逻辑）：才需要重新打包安卓客户端，覆盖安装即可（签名一致）。
- 安卓客户端启动时会拉 `agri-android.json` 比对版本号，有新版本就后台下载并拉起安装界面。

## 文档

- [产品功能、部署、网关与发布](app/README.md)
- [API 契约](app/API-CONTRACT.md) · [资产接口](app/ASSET-API.md) · [验证记录](app/VERIFICATION.md)
- [AI 架构（含双路回答与裁判）](docs/ai-architecture-2026-10-28.md)
- [语音交互报告](docs/voice-interaction-report-2026-10-27.md)
- [手机接入指南](docs/mobile-access-guide.md) · [麦克风与相机配置](docs/mobile-mic-camera-setup.md)
- [附图投递边界](docs/frontend-image-delivery-boundary.md)

## 仓库说明

- `main`：当前生产代码。
- `archive/pre-20261027`：10-21 旧版目录结构（扁平 `server/` `src/`）的完整存档，仅供回溯。
- 历史提交里的服务端 TLS 私钥已全部清除；签名密钥、数据库、上传目录、`.env` 均不入库。
- 代码中出现公网/内网地址是部署事实，不含任何凭据；模型密钥保存在服务器 `data/model-config.json`，接口只返回「是否已配置」。
