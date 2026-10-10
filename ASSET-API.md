# v0.4 资料资产与训练预留接口

基地址 `/api/v2`。使用现有登录 Cookie；POST 必须为 JSON 对象，携带 `Content-Type: application/json` 和 `X-Workbench: 1`。原有账号、资料发布和评审接口见 [API-CONTRACT.md](API-CONTRACT.md)。仅支持单企业、单服务进程。员工只能操作自己的导入，专家受领域授权限制，管理员可管理全域。

`request_id` 是客户端生成的 8–80 位字母、数字、下划线或连字符标识，建议 UUID。同一账号的同类请求重复提交相同参数返回原任务，换参数返回 409。`revision` 为服务端返回的当前整数版本；过期提交返回 409。未知/无权读取资源通常返回 404，角色或领域不足返回 403。输入错误 400、未登录 401、异步排队 202。读取任务状态直至完成或失败，不要把 202 当完成。

## 能力、清洗与标注

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/capabilities` | 能力状态；OCR、训练执行、部署当前为 false |
| GET | `/schemas/agriculture` | 标注字段、类型、长度限制 |
| GET | `/documents/:id/cleaning-report` | 本人或领域专家查看清洗规则、计数、警告和内容哈希 |
| POST | `/documents/:id/retry` | 本人或领域专家重试失败解析，提交 `{}` |
| POST | `/documents/:id/ocr` | 当前返回 503 / OCR_NOT_CONFIGURED |
| GET | `/documents/:id/annotation` | 标注、资料版本与 stale 状态 |
| POST | `/documents/:id/annotation` | 专家保存草稿，保留修订历史 |
| POST | `/documents/:id/annotation/approve` | 专家确认与当前已发布资料一致 |
| GET | `/documents/:id/knowledge?format=json` | 下载当前已审核知识 JSON；format 可改为 md |

先通过原有上传/发布流程取得资料 ID 和发布版本，再保存标注：

```json
{
  "revision": 0,
  "document_revision": 2,
  "fields": {
    "title": "番茄巡检规范",
    "crop": "番茄",
    "growth_stage": null,
    "applicable_conditions": ["核对采集时间和传感器单位"],
    "evidence_locations": ["段落 1"]
  }
}
```

首次标注 revision=0，后续使用最新返回值。未提供的信息保留 null 或空数组，不自动猜测。审批提交 `{"revision":1,"checked":true,"evidence":"已与原文核对"}`。重新发布资料后，旧标注不能直接导出，必须更新并再次审核。下载可带 `document_revision` 和 `annotation_revision`，版本不一致返回 409；响应含 ETag。

## 批量导入

1. POST `/imports`：`{request_id,items:[{name,domain,size?,source?,tags?}]}`，每批 1–100 份，返回 201 和条目 ID。
2. POST `/imports/:id/items/:itemId`：`{base64}`，逐份传输，返回 202。每份原始文件最多 8 MB；同条目重复相同内容可重试，不能用不同内容替换已上传条目。
3. GET `/imports/:id`：查询逐项解析状态、错误和汇总进度；GET `/imports` 获取本人列表（管理员可查全域）。文件解析失败使用上面的资料 retry 接口。

文件支持 TXT/MD、CSV、JSONL、DOCX、文字 PDF、XLSX。扫描 PDF 需要外部 OCR。清洗并不等于事实核实，发布仍需专家。

## 资产包

POST `/asset-exports`，专家提交：

```json
{
  "request_id": "客户端生成的UUID",
  "document_ids": ["资料ID"],
  "export_ids": [],
  "include_originals": false
}
```

资料 1–100 份，已审核数据集快照最多 10 份，可不带。创建时固定资料和标注版本，后续修改不会改变此包。原文件可选，可能含尚未脱敏的信息，仅授权用户可下载。原文件总量及 JSON 快照各限制 32 MB，生成内容总量限制 64 MB；超限请分批。

- GET `/asset-exports`、`/asset-exports/:id`：任务列表、queued/running/completed/failed 状态和错误。
- GET `/asset-exports/:id/manifest`：完成后的文件清单和 SHA256。
- GET `/asset-exports/:id/download`：ZIP，下载前验证包哈希。
- POST `/asset-exports/:id/retry`：`{}`，仅失败任务可重试。

ZIP 包含 `knowledge/*.md`、`annotations/*.json`、`cleaning-report.json`、`manifest.json`，以及可选的 `originals/*`、`datasets/*.jsonl`。MD 和 JSON 来自同一审核快照，含版本和来源。数据库备份还必须保留 uploads（其中包括 asset-packages）；现有 `npm run backup -- backups/唯一目录名` 会一起保存。

## 资料生成候选问答

- POST `/candidate-batches`：`{request_id,document_id,document_revision,count,model_role?,types?}`。专家发起，count 1–20，model_role 为 local/cloud（默认 local），types 可选“知识解释”“现场判断”“条件澄清”。返回 202。
- GET `/candidate-batches`、`/candidate-batches/:id`：状态及候选。源资料最多取前 40,000 字符，截断有标记。模型返回须包含原文引文，引用不存在则整批失败。
- POST `/candidate-batches/:id/retry`：失败后显式重试，原资料版本须仍有效。中断的模型调用不自动重发。
- POST `/candidates/:id/promote`：`{revision,checked:true,answer,evidence}`，专家核实后进入现有评审，返回 review_id；仍需通过 `/reviews/:id/approve` 审核。
- POST `/candidates/:id/exclude`：`{revision,reason}`，排除候选。

候选不会自动进入训练集。单回答仅能用于审核后的 SFT/评测，不能伪造成 DPO 双回答。关键操作继续执行独立复审。引用匹配只能证明引用存在，不能保证答案正确。

## 数据集与训练任务

以下仅管理员可用：

- POST `/datasets/export`：原有 `{kind:"sft"|"dpo"|"eval"}`，创建审核数据的不可变快照。
- GET `/datasets`：快照列表；GET `/datasets/:id/download`：JSONL 文件。
- POST `/datasets/validate`：`{export_id,eval_export_id?}`，检查格式、审核记录、重复问题、DPO 内容和训练/评测重叠；这是静态检查，runtime_validated=false。
- POST `/training/jobs`：创建训练草稿并锁定数据哈希，示例见下。
- GET `/training/jobs`、`/training/jobs/:id`、`/training/jobs/:id/logs`：查询任务与日志。
- POST `/training/jobs/:id/cancel`：`{}`，取消草稿。
- POST `/training/jobs/:id/start`：`{}`，当前返回 503 / TRAINING_EXECUTOR_NOT_CONFIGURED，状态仍为 draft。

```json
{
  "request_id": "客户端生成的UUID",
  "name": "番茄知识SFT第一批",
  "method": "sft",
  "base_model": "待部署基础模型的实际标识",
  "train_export_id": "sft快照ID",
  "eval_export_id": "eval快照ID",
  "hyperparameters": {"epochs": 1, "learning_rate": 0.0001, "max_length": 2048, "lora_rank": 16}
}
```

method 支持 sft/dpo，须对应训练快照类型。训练集与评测集不得含相同规范化问题或相同来源资料；审核未通过、空数据或重叠会被阻止。训练参数限于 epochs、learning_rate、max_length、lora_rank。还需在 DGX 阶段接训练执行器、分词器与模型模板校验、硬件检查和模型评估/发布，当前接口不会产出权重。
