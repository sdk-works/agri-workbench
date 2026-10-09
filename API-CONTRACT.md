# 数据管道 API v0.2

本机开发前缀 /api/v1，JSON。当前无正式登录；不应对外暴露。真实来源和裁判结果在 choice 提交前被服务端隐藏。

|方法与路径|行为|
|---|---|
|POST /comparisons|question + request_id 创建持久化异步任务。相同 ID/问题幂等，ID 复用不同问题返回 409|
|GET /comparisons|返回持久化列表，按盲评状态裁剪来源与裁判|
|GET /comparisons/:id|单条记录、固定 A/B、任务与审核状态|
|POST /comparisons/:id/choice|choice=A/B/tie/both_bad/insufficient，actor。只允许提交一次；不足两路只能 insufficient|
|POST /comparisons/:id/revision|answer/evidence/notes/actor/revision。修订版本乐观校验；进入 awaiting_review|
|POST /comparisons/:id/approve|actor/revision/preferred(null/A/B)/original_acceptable。检查复审人、版本与 DPO 准入|
|POST /comparisons/:id/exclude|actor/reason，保留记录排除训练|
|POST /datasets/export|kind=sft/dpo/eval。只取合格记录，持久化不可变导出快照|
|GET /models|本地安装情况与供应商配置情况，非生成成功保证|
|GET /health|版本、存储类型及基本配置状态，不返回密钥|

旧 chat/similarity/judge 接口保留兼容；新的问答 UI 使用 comparisons，客户端不再负责拼装和持久化偏好对。

生成状态 generating/completed/partial/failed；审核状态 unreviewed/pending/awaiting_review/approved/excluded。

生成与裁判仅更新自身字段，不覆盖人工修订。已审核记录不可再次修改。导出包含实际来源、完整生成上下文（当前独立问题）、人工选择、修订证据、复审、相似度算法和裁判实际模型。

DPO 输出为 prompt 消息数组、chosen/rejected 助手消息数组、meta。与具体训练器对接时仍需字段映射验证。

SQLite 当前保存版本化 JSON 记录和审计快照，适合内部小规模试用；列表分页、结构化分析索引、租户认证及 PostgreSQL 迁移为后续扩展。
