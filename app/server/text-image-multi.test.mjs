/**
 * 文字轮多图回归：正常对话走 /turns，也必须支持一次多张、顺序一致。
 *
 * 这条链路以前只认 b.image（单张 base64），front 也只读 files[0]，
 * 于是"相册多选"在正常对话里等于没生效。这里守住两件事：
 *   1. /turns 带 image_ids 时，多张全部进本轮，顺序不乱
 *   2. 有一张编号失效就整轮拒绝，不能静默少发一张
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

const shot = (tag, size) => ({
  buffer: Buffer.concat([Buffer.from("fake-png-" + tag + "-"), Buffer.alloc(size, 7)]),
  mime: "image/png",
  ext: "png",
});

test("文字轮：/turns 带两张图，按顺序全部进本轮", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("text-multi");
  const one = await f.ws.saveVoiceImage(a.user, {
    ...shot("t1", 13),
    conversation_id: "",
    dedup_key: "text-1",
  });
  const two = await f.ws.saveVoiceImage(a.user, {
    ...shot("t2", 26),
    conversation_id: "",
    dedup_key: "text-2",
  });
  const r = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这两张叶子分别是什么问题？",
      domain: domains[0],
      image_id: one.image_id,
      image_ids: [one.image_id, two.image_id],
    },
    a.cookie,
  );
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const raw = await f.repo.get("turns", r.data.id);
  assert.equal(raw.images.length, 2, "两张图都要进模型");
  assert.equal(raw.image_attachments.length, 2, "每张图都要有附件记录");
  assert.deepEqual(
    raw.image_attachments.map((a) => a.id),
    [one.image_id, two.image_id],
    "附件顺序必须是选图顺序",
  );
  assert.deepEqual(
    r.data.image_ids,
    [one.image_id, two.image_id],
    "对外结构要带有序编号",
  );
  // 对外结构不能把 base64 带出去
  const listed = await f.request("/turns", undefined, a.cookie);
  const item = listed.data.items.find((x) => x.id === r.data.id);
  assert.ok(item, "列表里要能查到这一轮");
  assert.equal(item.images, undefined, "列表不应返回图片本体");
  assert.deepEqual(item.image_ids, [one.image_id, two.image_id]);
});

test("文字轮：其中一张编号失效则整轮拒绝，不静默少发", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("text-multi-bad");
  const one = await f.ws.saveVoiceImage(a.user, {
    ...shot("t3", 9),
    conversation_id: "",
    dedup_key: "text-3",
  });
  const r = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这两张呢？",
      domain: domains[0],
      image_ids: [one.image_id, "not-a-real-image-id"],
    },
    a.cookie,
  );
  assert.equal(r.status, 404, "缺图必须报错，不能只发第一张");
  const turns = await f.repo.list("turns", { tenant: a.user.tenant, owner: a.user.id });
  assert.equal(turns.length, 0, "失败请求不应留下半截轮次");
});

test("文字轮：单张 image_id 老调用保持兼容", async (t) => {
  const f = await fixture(t, {});
  const a = await f.add("text-single");
  const one = await f.ws.saveVoiceImage(a.user, {
    ...shot("t4", 9),
    conversation_id: "",
    dedup_key: "text-4",
  });
  const r = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张什么病？",
      domain: domains[0],
      image_id: one.image_id,
    },
    a.cookie,
  );
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const raw = await f.repo.get("turns", r.data.id);
  assert.equal(raw.images.length, 1);
  assert.deepEqual(r.data.image_ids, [one.image_id]);
});
