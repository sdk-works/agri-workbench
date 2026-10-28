/**
 * 多图回归测试：同一轮按顺序带多张，单图调用保持兼容。
 *
 * 守的不变式：
 *   1. image_ids 的顺序就是用户选图顺序，模型不能"看到第二张却当成第一张"
 *   2. 单图 image_id 老调用不能被改坏
 *   3. 一轮超过 6 张要明确拒绝，不能悄悄截断
 *   4. base64 本体不能回给前端（列表响应会被撑爆）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";

const shot = (tag, size) => ({
  buffer: Buffer.concat([Buffer.from("fake-png-" + tag + "-"), Buffer.alloc(size, 7)]),
  mime: "image/png",
  ext: "png",
});

test("多图：一轮两张，顺序与上传顺序一致", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("multi-a");
  const one = await f.ws.saveVoiceImage(a.user, {
    ...shot("one", 11),
    conversation_id: "",
    dedup_key: "m-1",
  });
  const two = await f.ws.saveVoiceImage(a.user, {
    ...shot("two", 22),
    conversation_id: "",
    dedup_key: "m-2",
  });
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-multi-${randomUUID().slice(0, 8)}`,
    question: "这两张叶子分别是什么问题？",
    domain: "种植管理",
    image_ids: [one.image_id, two.image_id],
  });
  const raw = await f.repo.get("turns", created.turn_id);
  assert.equal(raw.images.length, 2, "两张图都要进本轮");
  assert.equal(raw.image_attachments.length, 2, "每张图都要有附件记录");
  assert.deepEqual(
    created.turn.image_ids,
    [one.image_id, two.image_id],
    "返回的编号顺序必须与用户选图顺序一致",
  );
  assert.ok(
    raw.images[0].data.length < raw.images[1].data.length,
    "第一张必须是第一张，不能串成后一张",
  );
  assert.equal(created.turn.images, undefined, "base64 本体不能回给前端");
  assert.match(raw.system_prompt, /本轮共 2 张图/, "多图必须告诉模型顺序");
  assert.equal(raw.model_plan.has_image, true, "多图轮必须走视觉模型");
});

test("多图：一次超过 6 张直接拒绝", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("multi-b");
  const ids = [];
  for (let i = 0; i < 7; i += 1) {
    const up = await f.ws.saveVoiceImage(a.user, {
      ...shot("cap" + i, i),
      conversation_id: "",
      dedup_key: "cap-" + i,
    });
    ids.push(up.image_id);
  }
  await assert.rejects(
    () =>
      f.ws.createVoiceTurn(a.user, {
        request_id: `req-cap-${randomUUID().slice(0, 8)}`,
        question: "七张图一起看",
        domain: "种植管理",
        image_ids: ids,
      }),
    /最多带 6 张/,
  );
});

test("单图兼容：只传 image_id 仍然可用", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("multi-c");
  const up = await f.ws.saveVoiceImage(a.user, {
    ...shot("solo", 33),
    conversation_id: "",
    dedup_key: "solo-1",
  });
  const created = await f.ws.createVoiceTurn(a.user, {
    request_id: `req-solo-${randomUUID().slice(0, 8)}`,
    question: "这张叶子怎么了？",
    domain: "种植管理",
    image_id: up.image_id,
  });
  const raw = await f.repo.get("turns", created.turn_id);
  assert.equal(raw.images.length, 1, "单图仍走同一条路径");
  assert.deepEqual(created.turn.image_ids, [up.image_id]);
  assert.doesNotMatch(raw.system_prompt, /本轮共 2 张图/, "单图不该出多图提示");
});
