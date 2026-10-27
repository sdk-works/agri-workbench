/**
 * 语音会话守卫单测（候选补丁，纯逻辑，主机可跑，不需要浏览器/真实音频）
 *
 * 覆盖明早手机验收要盯的四类行为，先在这里用假回调证明：
 *   1. 打断：新请求先停播报再撤旧请求（顺序反了会自激），旧流不再写文本
 *   2. 重复提交：同一 request_id 在途时复用，不重复 POST
 *   3. 上传：缩略图不算上传成功，必须拿到服务端 image_id 才能带图提问
 *   4. 权限拒绝/取消/切后台/断线：都能回到可恢复状态，且不会补发请求
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceGuard } from "./voice-session-guard.mjs";

function harness(over = {}) {
  const events = [];
  const order = [];
  const speaking = { on: false };
  const guard = createVoiceGuard({
    now: over.now || (() => Date.now()),
    onEvent: (e) => events.push(e),
    stopSpeaking: async () => {
      order.push("stop-tts");
      speaking.on = false;
    },
    cancelRequest: async (rid) => {
      order.push("cancel:" + rid);
    },
  });
  return { guard, events, order, speaking };
}

test("打断：先停播报再撤旧请求，旧 SSE 不再写入", async () => {
  const { guard, events, order, speaking } = harness();
  let oldAborted = false;
  await guard.ask({
    request_id: "r-1",
    question: "第一个问题",
    send: async ({ signal }) => {
      signal.addEventListener("abort", () => {
        oldAborted = true;
      });
      return "old-stream";
    },
  });
  speaking.on = true;
  guard.beginSpeaking();
  assert.equal(guard.phase, "speaking");

  const out = await guard.ask({
    request_id: "r-2",
    question: "第二个问题",
    send: async () => "new-stream",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(order, ["stop-tts", "cancel:r-1"], "顺序必须是先停播报再撤请求");
  assert.equal(oldAborted, true, "旧请求必须被中止，否则两条流同时写答案");
  assert.equal(guard.activeRequestId, "r-2");
  assert.ok(events.some((e) => e.type === "interrupt" && e.target === "tts"));
});

test("重复提交：同一 request_id 在途时不重复发", async () => {
  const { guard } = harness();
  let calls = 0;
  const send = async () => {
    calls += 1;
    return "stream";
  };
  await guard.ask({ request_id: "same-1", question: "问题", send });
  const again = await guard.ask({ request_id: "same-1", question: "问题", send });
  assert.equal(again.reused, true);
  assert.equal(calls, 1, "同一 request_id 只能真正发出一次");
  await guard.ask({ request_id: "other-2", question: "另一个问题", send });
  assert.equal(calls, 2, "不同 request_id 应正常发出");
});

test("上传：缩略图不算上传成功，没有 image_id 不能带图提问", async () => {
  const { guard, events } = harness();
  guard.pickImage("local-1", 1234);
  assert.equal(
    guard.confirmedUploads().length,
    0,
    "只是选了图/有缩略图时，不应算已上传",
  );
  const blocked = await guard.ask({
    request_id: "r-img-1",
    question: "看看这个",
    image_local_id: "local-1",
    send: async () => "stream",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "image-not-confirmed");

  guard.startUpload("local-1");
  const bad = guard.confirmUpload("local-1", "");
  assert.equal(bad.ok, false, "没有 image_id 的确认必须判失败，不能靠前端自己造");

  const ok = guard.confirmUpload("local-1", "srv-id-1");
  assert.equal(ok.ok, true);
  assert.equal(guard.confirmedUploads()[0].image_id, "srv-id-1");

  let sent = null;
  const out = await guard.ask({
    request_id: "r-img-2",
    question: "看看这个",
    image_local_id: "local-1",
    send: async (p) => {
      sent = p;
      return "stream";
    },
  });
  assert.equal(out.ok, true);
  assert.equal(sent.image_id, "srv-id-1", "带图提问必须带服务端编号");
  assert.ok(events.some((e) => e.type === "upload" && e.state === "uploaded"));
});

test("上传失败：保留失败态可重试，不伪装成功", () => {
  const { guard } = harness();
  guard.pickImage("local-2");
  guard.startUpload("local-2");
  guard.failUpload("local-2", "网络中断");
  assert.equal(guard.uploads.get("local-2").state, "failed");
  assert.equal(guard.confirmedUploads().length, 0, "失败的图片不得进入可提问集合");
  guard.startUpload("local-2");
  guard.confirmUpload("local-2", "srv-id-2");
  assert.equal(guard.confirmedUploads().length, 1, "重试成功后可用");
});

test("播报期间不启动录音（避免自激）；结束后恢复", async () => {
  const { guard } = harness();
  await guard.ask({ request_id: "r-3", question: "问题", send: async () => "s" });
  guard.beginSpeaking();
  const denied = guard.requestMic();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "speaking");
  guard.finishSpeaking();
  assert.equal(guard.requestMic().ok, true, "播报结束后应允许录音");
});

test("取消/切后台/断线：回到可恢复状态，不自动补发", async () => {
  const { guard, events } = harness();
  await guard.ask({ request_id: "r-4", question: "问题", send: async () => "s" });
  const aborted = guard.abort("background");
  assert.equal(aborted.request_id, "r-4");
  assert.equal(guard.phase, "idle");
  assert.equal(guard.activeRequestId, "");

  await guard.ask({ request_id: "r-5", question: "问题", send: async () => "s" });
  const re = guard.reconnect();
  assert.equal(re.needsResend, true, "断线时应提示需要重发，而不是静默补发");
  assert.equal(guard.phase, "idle");
  assert.ok(events.some((e) => e.type === "reconnect"));
});

test("权限拒绝：取消录音不留悬挂请求", async () => {
  const { guard } = harness();
  const g = guard;
  g.pickImage("local-3");
  const denied = g.abort("permission-denied");
  assert.equal(denied.ok, true);
  assert.equal(g.phase, "idle");
  assert.equal(g.activeRequestId, "");
});
