# API v2 合约

前缀 `/api/v2`。JSON 请求；所有 POST 必须带 `X-Workbench: 1`。Cookie 会话认证，服务端授权，不信任请求中的 actor/role 字段。返回 JSON，错误 `{error}`。POST 限制 12 MB，文件解码后最多 8 MB。

## 账号

- GET `/auth/status`：是否需要初始化、当前用户安全字段。
- POST `/auth/setup`：仅无账号时可用，`{username,name,password}` 创建管理员。
- POST `/auth/login`：`{username,password}`，写入 HttpOnly / SameSite=Strict 会话 Cookie。
- POST `/auth/logout`：注销当前会话。
- GET/POST `/users`：仅管理员；POST `{id?,username,name,password?,role,domains,active}`。停用或重设密码撤销该账号会话。

领域为 `种植管理 / 农业物联网 / 农业销售`。身份为 `employee / expert / admin`。

## 员工问答

- GET `/conversations`：自己的会话。
- GET `/turns?conversation_id=...`：自己的问答轮；反馈前隐藏真实模型，普通员工永不接收裁判结果。
- POST `/turns`：`{request_id,question,domain,conversation_id?}`，202 返回已持久化任务。相同 request_id 幂等，问题不同返回 409。
- POST `/turns/:id/feedback`：`{choice,comment?}`，choice 为 A/B/tie/both_bad/insufficient。只允许本人反馈，可更新；不改写历史上下文。

模型任务持久化，生成、裁判、解析分队列异步执行。生成中断不会自动重复付费请求；裁判/解析中断可恢复。单实例部署，裁判恢复为至少一次执行，不能保证供应商只计费一次。

## 专家评审

- GET `/reviews`：仅授权领域。
- GET `/reviews/:id`：主案例、合并回答、真实上下文、裁判和修订版本。
- POST `/reviews/:id/claim`：领取 30 分钟。
- POST `/reviews/:id/save`：`{revision,answer,evidence,notes?}`，版本冲突 409。
- POST `/reviews/:id/approve`：`{revision,preferred?,original_acceptable?,issue_confirmed?}`。preferred 为 A/B 或空；DPO 必须完整双回答且确认原答合格；关键案例须不同专家。
- POST `/reviews/:id/exclude`：`{revision,reason}`。

已审核/排除任务只读。普通案例单专家即可确认；原始员工偏好不等于训练标签。

## 资料

- GET `/documents`：本人上传、领域授权或已发布资料的元数据。
- POST `/documents`：`{name,base64,domain,source,tags?}`，202 保存原文件并排队清洗；重复文件返回 existing document。
- GET `/documents/:id`：允许范围内的清洗/发布文本；专家可读发布历史。
- GET `/documents/:id/original`：本人或授权专家可下载原文件，附件响应。
- POST `/documents/:id/publish`：专家提交 `{revision,text,evidence,checked:true}`，保留审核版本。
- POST `/documents/:id/reject`：专家提交 `{revision,reason}`。
- POST `/documents/:id/training-question`：专家提交 `{request_id,question}`，以发布资料为指定来源建立送审候选。

## 管理与统计

- GET/POST `/models`：仅管理员，角色 local/cloud/judge/fallback；各配置 `{adapter,base_url,model,api_key?,clear_key?,enabled?,input_price?,output_price?}`。adapter 为 ollama/compatible，fallback 的 enabled 控制降级。单价为元/百万 token。响应无密钥，空密钥默认不修改，clear_key 才清除。
- GET/POST `/rules`：`{sample_rate:0..1,review_daily_limit:1..1000,judge_attempts:1..5}`。
- GET `/jobs`、POST `/jobs/:id/retry`：管理员读取任务、重试失败裁判。
- GET `/metrics`：专家领域内统计；包含送审、抽查、已确认问题、裁判一致性、等待审核时长及成功调用费用估算。
- POST `/datasets/export`：管理员提交 `{kind:sft|dpo|eval}`，返回 `{id,created_at,schema_version:2,items}`，保存不可变快照。
- GET `/legacy`：管理员只读旧版记录。
- GET `/events`：管理员最近 200 条操作事件。

公开 GET `/api/v1/health` 仅返回服务版本和存储类型；其余 v1 接口已停用（410），避免绕过新版权限。
