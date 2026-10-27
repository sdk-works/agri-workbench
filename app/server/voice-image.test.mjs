import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";

// 会话图片：上传 → image_id → 随轮提交。重点验证「行为」而不是字段是否存在：
// 谁都能读？会不会静默退纯文本？换图会不会串？同一个 id 能不能连续追问？

const png = () => ({
  buffer: Buffer.from("fake-png-bytes-for-test"),
  mime: "image/png",
  ext: "png",
});

async function upload(f, user) {
  return f.ws.saveVoiceImage(user, {
    ...png(),
    conversation_id: "conv-test",
  });
}

function imageCall(captured) {
  return async (role, messages, json, images) => {
    captured.push({ role, messages, images });
    return {
      answer: `${role} 看了图的回答`,
      model: role + "-model",
      provider: role === "local" ? "local" : "cloud",
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  };
}

test("上传返回 image_id，落盘可读，跨用户读不到", async (t) => {
  const f = await fixture(t);
  const a = await f.add("img-a"),
    b = await f.add("img-b");
  const up = await upload(f, a.user);
  assert.match(up.image_id, /^[0-9a-f-]{36}$/);
  assert.equal(up.mime, "image/png");
  assert.equal(up.bytes, png().buffer.length);

  const mine = await f.ws.loadVoiceImage(a.user, up.image_id);
  assert.equal(mine.mime, "image/png");
  assert.equal(
    Buffer.from(mine.data, "base64").toString(),
    png().buffer.toString(),
  );

  // 同租户的另一个用户也不行：附件按 owner 隔离
  await assert.rejects(
    () => f.ws.loadVoiceImage(b.user, up.image_id),
    /不存在|无权/,
  );
  // 随便编一个 id 同样 404，不暴露「存在但没权限」
  await assert.rejects(
    () => f.ws.loadVoiceImage(a.user, randomUUID()),
    /不存在|无权/,
  );
});

test("上传拒绝非法扩展名与不一致的 mime", async (t) => {
  const f = await fixture(t);
  const a = await f.add("img-bad");
  await assert.rejects(
    () =>
      f.ws.saveVoiceImage(a.user, {
        buffer: Buffer.from("x"),
        mime: "image/gif",
        ext: "gif",
      }),
    /仅支持/,
  );
  await assert.rejects(
    () =>
      f.ws.saveVoiceImage(a.user, {
        buffer: Buffer.from("x"),
        mime: "image/gif",
        ext: "png",
      }),
    /类型与扩展名不一致/,
  );
  await assert.rejects(
    () => f.ws.saveVoiceImage(a.user, { buffer: Buffer.alloc(0), mime: "image/png", ext: "png" }),
    /内容为空/,
  );
});

test("带 image_id 建轮：附件关联、base64 不外泄、只走视觉候选", async (t) => {
  const captured = [];
  const f = await fixture(t, { call: imageCall(captured) });
  const a = await f.add("img-c");
  const up = await upload(f, a.user);
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张图里的叶片是什么问题",
      domain: "种植管理",
      image_id: up.image_id,
    },
    a.cookie,
  );
  assert.equal(out.status, 202, JSON.stringify(out.data));
  await f.ws.tick("generate");

  // 只能有一个视觉候选，且不能是纯文本的 cloud
  assert.equal(captured.length, 1);
  assert.equal(captured[0].role, "vision");
  assert.equal(captured[0].images.length, 1);
  assert.equal(
    Buffer.from(captured[0].images[0].data, "base64").toString(),
    png().buffer.toString(),
  );

  const turn = (await f.request("/turns", undefined, a.cookie)).data.items.find(
    (x) => x.id === out.data.id,
  );
  assert.equal(turn.image.has_image, true);
  assert.equal(turn.image.attachment_id, up.image_id);
  assert.equal(turn.image.data, undefined, "base64 不能出现在列表里");
});

test("没有可看图模型时带图明确 503，不建轮、不静默退纯文本", async (t) => {
  const captured = [];
  const f = await fixture(t, {
    call: imageCall(captured),
    disabled: ["vision", "local"],
  });
  const a = await f.add("img-novision");
  const up = await upload(f, a.user);
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张图里的叶片是什么问题",
      domain: "种植管理",
      image_id: up.image_id,
    },
    a.cookie,
  );
  assert.equal(out.status, 503);
  assert.match(out.data.error, /没有可看图的模型/);
  await f.ws.tick("generate");
  assert.equal(captured.length, 0);
  const list = (await f.request("/turns", undefined, a.cookie)).data.items;
  assert.equal(list.length, 0);
});

test("视觉上游失败：轮次失败且错误可见，不假装看过图", async (t) => {
  const f = await fixture(t, {
    call: async () => {
      throw Object.assign(Error("image input is not supported"), {
        code: "upstream",
      });
    },
  });
  const a = await f.add("img-fail");
  const up = await upload(f, a.user);
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张图里的叶片是什么问题",
      domain: "种植管理",
      image_id: up.image_id,
    },
    a.cookie,
  );
  assert.equal(out.status, 202);
  await f.ws.tick("generate");
  const turn = (await f.request("/turns", undefined, a.cookie)).data.items.find(
    (x) => x.id === out.data.id,
  );
  assert.equal(turn.status, "failed");
  assert.match(JSON.stringify(turn.candidates), /image input is not supported/);
  assert.doesNotMatch(JSON.stringify(turn.candidates), /看了图的回答/);
});

test("同图连续追问仍是同一附件，换图后指向新附件", async (t) => {
  const captured = [];
  const f = await fixture(t, { call: imageCall(captured) });
  const a = await f.add("img-follow");
  const first = await upload(f, a.user);
  const ask = async (q, imageId) => {
    const r = await f.request(
      "/turns",
      {
        request_id: randomUUID(),
        question: q,
        domain: "种植管理",
        image_id: imageId,
      },
      a.cookie,
    );
    assert.equal(r.status, 202, JSON.stringify(r.data));
    await f.ws.tick("generate");
    return r.data;
  };
  const t1 = await ask("第一轮：叶片上有什么", first.image_id);
  const t2 = await ask("那要不要马上打药", first.image_id);
  const second = await upload(f, { ...a.user });
  const t3 = await ask("换一张：这张呢", second.image_id);

  const list = (await f.request("/turns", undefined, a.cookie)).data.items;
  const at = (id) => list.find((x) => x.id === id).image.attachment_id;
  assert.equal(at(t1.id), first.image_id);
  assert.equal(at(t2.id), first.image_id, "追问沿用的是同一张图");
  assert.equal(at(t3.id), second.image_id, "换图后必须指向新附件");
  assert.notEqual(first.image_id, second.image_id);
});

test("image 与 image_id 同时传要拒绝，避免两套来源打架", async (t) => {
  const f = await fixture(t);
  const a = await f.add("img-both");
  const up = await upload(f, a.user);
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "两个都带会怎样",
      domain: "种植管理",
      image_id: up.image_id,
      image: { mime: "image/png", data: Buffer.from("x").toString("base64") },
    },
    a.cookie,
  );
  assert.equal(out.status, 400);
  assert.match(out.data.error, /只能选一种/);
});

test("附件记录回填 conversation_id 与 turn_id", async (t) => {
  const f = await fixture(t);
  const a = await f.add("img-link");
  const up = await upload(f, a.user);
  const out = await f.request(
    "/turns",
    {
      request_id: randomUUID(),
      question: "这张图能看出什么",
      domain: "种植管理",
      image_id: up.image_id,
    },
    a.cookie,
  );
  await f.ws.tick("generate");
  const rec = await f.repo.get("voice_images", up.image_id);
  assert.equal(rec.turn_id, out.data.id);
  assert.equal(rec.conversation_id, out.data.conversation_id);
  assert.equal(rec.owner, a.user.id);
});
