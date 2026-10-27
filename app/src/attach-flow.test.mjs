// 附图状态机行为测试：断言的是「什么时候能说上传成功」，不是字段名。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACH,
  STAGE,
  emptyAttach,
  pick,
  startUpload,
  uploadOk,
  uploadFail,
  beginAnalysis,
  analysisOk,
  analysisFail,
  clear,
  switchConversation,
  canSend,
  isUploaded,
  canRetryUpload,
  canRetryAnalysis,
  describe,
  turnReference,
} from "./attach-flow.mjs";

const picked = () =>
  pick(emptyAttach(), { url: "blob:x", mime: "image/jpeg", bytes: 1024, at: 1 });

test("刚选中：只有本地缩略图，不能声称已上传", () => {
  const s = picked();
  assert.equal(s.status, ATTACH.PICKED);
  assert.equal(s.id, "");
  assert.equal(isUploaded(s), false);
  assert.equal(canSend(s), false, "还没上传就不能随问题发出");
  const d = describe(s);
  assert.match(d.text, /还没上传/);
  assert.doesNotMatch(d.text, /已上传|已收到|成功/);
});

test("上传中：依旧没有 image_id，文案不承诺成功", () => {
  const s = startUpload(picked());
  assert.equal(s.status, ATTACH.UPLOADING);
  assert.equal(s.id, "");
  assert.equal(isUploaded(s), false);
  assert.equal(canSend(s), false);
  assert.doesNotMatch(describe(s).text, /已上传|成功/);
});

test("服务端返回 image_id 才算上传成功", () => {
  const s = uploadOk(startUpload(picked()), { imageId: "img-1" });
  assert.equal(s.status, ATTACH.RECEIVED);
  assert.equal(s.id, "img-1");
  assert.equal(isUploaded(s), true);
  assert.equal(canSend(s), true);
});

test("服务端没给编号就当成失败，不能假装成功", () => {
  const s = uploadOk(startUpload(picked()), { imageId: "" });
  assert.equal(s.status, ATTACH.FAILED);
  assert.equal(s.stage, STAGE.UPLOAD);
  assert.equal(s.id, "");
});

test("上传失败：缩略图留着，可以原地重试", () => {
  const s = uploadFail(startUpload(picked()), "网络中断");
  assert.equal(s.status, ATTACH.FAILED);
  assert.equal(s.url, "blob:x", "失败不能把用户选的图丢掉");
  assert.equal(canRetryUpload(s), true);
  assert.equal(canSend(s), false);
  assert.match(describe(s).text, /上传失败/);
});

test("上传重试沿用同一幂等键：同一张图不会重复落盘", () => {
  const a = picked();
  const failed = uploadFail(startUpload(a), "超时");
  const retry = startUpload(failed);
  assert.equal(retry.dedupKey, a.dedupKey);
  assert.equal(retry.url, a.url);
});

test("随轮次提交后进入分析中，并记住这一轮的 requestId / turnId", () => {
  const s = beginAnalysis(uploadOk(startUpload(picked()), { imageId: "img-2" }), {
    requestId: "req-1",
    turnId: "turn-1",
    conversationId: "conv-1",
  });
  assert.equal(s.status, ATTACH.ANALYZING);
  assert.equal(s.requestId, "req-1");
  assert.equal(s.turnId, "turn-1");
  assert.equal(canSend(s), true, "同一张图可在追问里继续用");
});

test("没有服务端凭据时不允许进入分析态", () => {
  const s = beginAnalysis(picked(), { requestId: "req-1" });
  assert.equal(s.status, ATTACH.PICKED);
});

test("分析完成 → done", () => {
  const s = analysisOk(
    beginAnalysis(uploadOk(startUpload(picked()), { imageId: "img-3" }), {
      requestId: "req-2",
      turnId: "turn-2",
    }),
  );
  assert.equal(s.status, ATTACH.DONE);
  assert.match(describe(s).text, /已分析完成/);
});

test("分析失败保留 requestId，重试不会新建一轮", () => {
  const base = beginAnalysis(uploadOk(startUpload(picked()), { imageId: "img-4" }), {
    requestId: "req-keep",
    turnId: "turn-keep",
  });
  const failed = analysisFail(base, "视觉模型不可用");
  assert.equal(failed.status, ATTACH.FAILED);
  assert.equal(failed.stage, STAGE.ANALYZE);
  assert.equal(canRetryAnalysis(failed), true);
  assert.equal(canRetryUpload(failed), false, "分析失败不该走上传重试");
  // 重试用同一 requestId + 同一 image_id
  assert.equal(failed.requestId, "req-keep");
  assert.equal(failed.id, "img-4");
  assert.match(describe(failed).text, /分析失败/);
});

test("删除：状态清空，旧凭据不残留", () => {
  const s = clear();
  assert.equal(s.status, ATTACH.NONE);
  assert.equal(s.id, "");
  assert.equal(s.url, "");
  assert.equal(canSend(s), false);
});

test("切会话：已绑定别的会话的图必须丢掉", () => {
  const s = beginAnalysis(uploadOk(startUpload(picked()), { imageId: "img-5" }), {
    requestId: "req-5",
    conversationId: "conv-A",
  });
  const after = switchConversation(s, "conv-B");
  assert.equal(after.status, ATTACH.NONE, "切会话后不能把上一张图带过去");
  assert.equal(after.id, "");
  const same = switchConversation(s, "conv-A");
  assert.equal(same.id, "img-5", "留在同一会话时图不受影响");
});

test("本轮引用：以服务端附件编号为准，不认页面残留", () => {
  const s = beginAnalysis(uploadOk(startUpload(picked()), { imageId: "img-6" }), {
    requestId: "req-6",
  });
  assert.deepEqual(turnReference(s, "img-6"), { kind: "same", url: "blob:x" });
  assert.equal(turnReference(s, "img-other").kind, "other");
  assert.equal(turnReference(s, "").kind, "none");
});
