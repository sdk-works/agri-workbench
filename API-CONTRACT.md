# 后端接入契约草案

统一前缀 `/api/v1`。身份、租户由后端登录上下文决定，不信任前端传入的用户/租户标识。
所有写操作须加入鉴权、CSRF防护（Cookie会话模式）、审计和适当的幂等处理。

## POST /chat

请求：
```json
{"model":"local_agri","messages":[{"role":"user","content":"番茄开花期如何管理水肥？"}]}
```
响应：
```json
{"request_id":"uuid","answer":"模型回答","model":"实际模型版本","provider":"local","citations":[],"usage":{"input_tokens":0,"output_tokens":0}}
```
后端负责历史长度、农业范围、数据权限和输出检查，不能把浏览器传入的模型名直接当作任意端点。
前端当前读取 `answer`；流式回答在后续增加。

## 待实现接口

|接口|职责|
|---|---|
|GET /models|返回逻辑模型、能力、连接状态，不返回密钥|
|POST /comparisons|同一证据快照下生成候选回答，保存实际模型来源|
|GET /reviews|按权限和状态分页读取评审任务|
|POST /reviews/:id|提交选择、修订、建议及版本，进行并发校验|
|POST /reviews/:id/approve|复审权限校验并形成不可变审核记录|
|POST /documents|实际 multipart 文件上传、限额、扫描和存储|
|GET /documents|返回资料元数据与解析/审核状态|
|POST /datasets|从审核记录建立版本化快照，排除演示数据|
|POST /training-jobs|在后端权限和资源检查后提交任务|
|GET /training-jobs/:id|真实进度、失败原因和评测产物|

前端所有演示状态须在接入时替换为服务器权威状态，并实现加载、错误、重试与刷新恢复。
不应将演示内存状态改成 localStorage 就视为正式数据库。
