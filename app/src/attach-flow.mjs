/**
 * 会话附图状态机（纯逻辑，不碰 DOM，可直接单测）。
 *
 * 为什么单独抽出来：图片的「有没有上传成功」过去是靠缩略图在不在判断，
 * 于是本地还在转圈就显示成上传好了。这里把状态和 UI 拆开，让「服务器确认」
 * 成为唯一的事实来源：没有 image_id 就不可能被标记成已上传。
 *
 * 六个状态（与需求逐条对应）：
 *   picked    已选中：本地有图和缩略图，但服务器还没收到
 *   uploading 上传中：正在 POST /voice/image。接口一次请求完成，拿不到真实
 *             字节进度，所以不显示百分比——不编造独立进度
 *   received  服务端已接收：拿到了 image_id，这才是真的上传成功
 *   analyzing 分析中：已随某一轮问题提交，等回答
 *   done      完成：这一轮回答结束，图确实被看过
 *   failed    失败：分 upload（图没传上去）和 analyze（图传上去了但模型没看成）
 *
 * 不变式（测试逐条守）：
 *   1. 除 received/analyzing/done 外，id 必须为空 —— 本地缩略图不等于上传成功
 *   2. 上传重试沿用同一 dedupKey —— 不重复落盘
 *   3. 分析重试沿用同一 requestId —— 不重复建轮次
 *   4. 换图 / 切会话后，旧图的任何凭据都不能带进新上下文
 */

export const ATTACH = {
  NONE: "",
  PICKED: "picked",
  UPLOADING: "uploading",
  RECEIVED: "received",
  ANALYZING: "analyzing",
  DONE: "done",
  FAILED: "failed",
};

export const STAGE = { UPLOAD: "upload", ANALYZE: "analyze" };

// 有 image_id 的状态集合：只有这几个能被打上「已上传」的说法
const WITH_ID = new Set([ATTACH.RECEIVED, ATTACH.ANALYZING, ATTACH.DONE]);

export function emptyAttach() {
  return {
    status: ATTACH.NONE,
    id: "",
    url: "",
    mime: "",
    bytes: 0,
    dedupKey: "",
    requestId: "",
    turnId: "",
    conversationId: "",
    stage: "",
    error: "",
    duplicate: false,
    pickedAt: 0,
  };
}

/** 选中一张图（拍照或相册）：进入预览，尚未上传 */
export function pick(state, { url = "", mime = "", bytes = 0, dedupKey = "", at = 0 } = {}) {
  if (!url) return state;
  return {
    ...emptyAttach(),
    status: ATTACH.PICKED,
    url,
    mime,
    bytes,
    // 幂等键在选中时就定下，之后所有上传重试都用它
    dedupKey: dedupKey || `d${at}-${Math.random().toString(36).slice(2, 10)}`,
    pickedAt: at,
  };
}

/** 开始上传：只允许从「已选中」或「上传失败」进入 */
export function startUpload(state) {
  const okFrom =
    state.status === ATTACH.PICKED ||
    (state.status === ATTACH.FAILED && state.stage === STAGE.UPLOAD);
  if (!okFrom) return state;
  return { ...state, status: ATTACH.UPLOADING, stage: "", error: "" };
}

/** 服务端确认收到：这是唯一能产生 id 的入口 */
export function uploadOk(state, { imageId = "", duplicate = false } = {}) {
  if (!imageId) return uploadFail(state, "服务端没有返回图片编号");
  return {
    ...state,
    status: ATTACH.RECEIVED,
    id: imageId,
    duplicate: duplicate === true,
    stage: "",
    error: "",
  };
}

export function uploadFail(state, error = "上传失败") {
  return { ...state, status: ATTACH.FAILED, stage: STAGE.UPLOAD, id: "", error };
}

/** 随某轮问题提交：记下这一轮的 requestId / turnId / conversationId */
export function beginAnalysis(state, { requestId = "", turnId = "", conversationId = "" } = {}) {
  if (!state.id) return state; // 没有服务端凭据就不可能进入分析
  return {
    ...state,
    status: ATTACH.ANALYZING,
    stage: "",
    error: "",
    requestId: requestId || state.requestId,
    turnId: turnId || state.turnId,
    conversationId: conversationId || state.conversationId,
  };
}

export function analysisOk(state) {
  if (state.status !== ATTACH.ANALYZING) return state;
  return { ...state, status: ATTACH.DONE, error: "" };
}

export function analysisFail(state, error = "分析失败") {
  return { ...state, status: ATTACH.FAILED, stage: STAGE.ANALYZE, error };
}

/**
 * 用户主动取消：不是失败。图本身还是好的，退回「服务器已收到」，
 * 既能让用户接着用它重问，也不会把取消算进失败率。
 */
export function analysisCanceled(state) {
  if (state.status !== ATTACH.ANALYZING) return state;
  return { ...state, status: ATTACH.RECEIVED, stage: "", error: "" };
}

/** 用户主动删掉这张图 / 关掉会话 */
export function clear() {
  return emptyAttach();
}

/**
 * 切换会话：图必须一起丢，否则会把上一个会话的图带进新会话。
 * 返回新状态，调用方负责释放旧的 objectURL。
 */
export function switchConversation(state, conversationId = "") {
  if (!state.url) return state;
  if (state.conversationId && state.conversationId !== conversationId)
    return emptyAttach();
  return state;
}

/** 能不能把这张图随问题发出去 */
export function canSend(state) {
  return WITH_ID.has(state.status);
}

/** 是否在等某个后台动作（上传/分析），UI 据此显示忙碌 */
export function isBusy(state) {
  return state.status === ATTACH.UPLOADING || state.status === ATTACH.ANALYZING;
}

/** 只有这三个状态可以对外说「已上传/服务器已收到」 */
export function isUploaded(state) {
  return WITH_ID.has(state.status);
}

/** 上传失败可重试；分析失败也可重试，但两者重试语义不同 */
export function canRetryUpload(state) {
  return state.status === ATTACH.FAILED && state.stage === STAGE.UPLOAD;
}

export function canRetryAnalysis(state) {
  return state.status === ATTACH.FAILED && state.stage === STAGE.ANALYZE;
}

/**
 * 状态文案。刻意把「还没上传」讲明白，避免用户把本地缩略图当成已发送。
 * 返回 { text, tone }，tone ∈ ok|busy|warn|err。
 */
export function describe(state) {
  switch (state.status) {
    case ATTACH.PICKED:
      return { text: "已选中，还没上传", tone: "warn" };
    case ATTACH.UPLOADING:
      return { text: "正在上传，等服务器确认…", tone: "busy" };
    case ATTACH.RECEIVED:
      return { text: "服务器已收到，发送问题后开始分析", tone: "ok" };
    case ATTACH.ANALYZING:
      return { text: "正在看这张图…", tone: "busy" };
    case ATTACH.DONE:
      return { text: "这张图已分析完成", tone: "ok" };
    case ATTACH.FAILED:
      return {
        text:
          state.stage === STAGE.UPLOAD
            ? `上传失败：${state.error || "网络问题"}`
            : `分析失败：${state.error || "模型没有返回内容"}`,
        tone: "err",
      };
    default:
      return { text: "", tone: "" };
  }
}

/**
 * 本轮实际引用了哪张图：以服务端回来的附件编号为准，而不是页面上的残留。
 * serverId 为空表示这一轮没带图。
 */
export function turnReference(state, serverId = "") {
  if (!serverId) return { kind: "none" };
  if (state && state.id === serverId) return { kind: "same", url: state.url };
  return { kind: "other", id: serverId };
}
