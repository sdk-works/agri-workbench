/**
 * 模型能力声明的回归测试（2026-10-27 切 qwen3-vl 时新增）
 *
 * 守两件已经踩过的事：
 *   1. qwen3-vl-*-instruct 不带推理开关，收到 think:true 会 400 "does not support thinking"，
 *      导致所有深度轮失败并溢出到云端 → 必须按能力声明屏蔽 think。
 *   2. save() 重建角色对象时只写 7 个基础字段，会把 supports_image / supports_think 抹掉，
 *      在界面保存一次模型配置就会让"拍照没法看图"复发 → 必须原样带回。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./model-gateway.mjs";

const cfgOf = (local = {}) => ({
  local: {
    adapter: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "vl-model",
    api_key: "",
    supports_image: true,
    supports_think: false,
    ...local,
  },
  cloud: {
    adapter: "compatible",
    base_url: "https://api.example.com/v1",
    model: "gpt-x",
    api_key: "k",
    enabled: true,
  },
  judge: {
    adapter: "compatible",
    base_url: "https://api.example.com/v1",
    model: "judge-x",
    api_key: "k",
    enabled: false,
  },
  fallback: {
    enabled: false,
    adapter: "ollama",
    base_url: "http://127.0.0.1:11434",
    model: "fb-model",
    api_key: "",
  },
});

function setup(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agri-cap-"));
  const file = path.join(dir, "model-config.json");
  fs.writeFileSync(file, JSON.stringify(cfgOf(local)));
  const bodies = [];
  const gateway = createGateway(
    {},
    file,
    {
      fetcher: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            message: { content: "好" },
            prompt_eval_count: 10,
            eval_count: 5,
            done: true,
          }),
        };
      },
    },
  );
  return { dir, file, bodies, gateway };
}

const msg = () => [{ role: "user", content: "你好" }];

test("声明 supports_think:false 的模型收不到 think 参数（否则 Ollama 返回 400）", async () => {
  const { bodies, gateway } = setup();
  await gateway.call("local", msg(), false, null, null, { think: true });
  assert.equal(bodies.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(bodies[0], "think"),
    false,
    "不支持思考的模型必须完全不发 think 字段",
  );
});

test("未声明 supports_think 的模型保持原行为，照传 think:true", async () => {
  const { bodies, gateway } = setup({
    model: "qwen3.8-27b",
    supports_think: undefined,
  });
  // supports_think: undefined 存进 JSON 会被丢弃，等价于"未声明"
  await gateway.call("local", msg(), false, null, null, { think: true });
  assert.equal(bodies[0].think, true, "既有 27B 配置不能因这次改动改变行为");
});

test("声明 supports_think:true 的模型正常收到 think:true", async () => {
  const { bodies, gateway } = setup({ supports_think: true });
  await gateway.call("local", msg(), false, null, null, { think: true });
  assert.equal(bodies[0].think, true);
});

test("保存模型配置不会清掉能力声明（拍照 503 的复发点）", async () => {
  const { file, gateway } = setup();
  gateway.save({
    local: {
      adapter: "ollama",
      base_url: "http://127.0.0.1:11434",
      model: "vl-model",
      enabled: true,
    },
    cloud: {
      adapter: "compatible",
      base_url: "https://api.example.com/v1",
      model: "gpt-x",
      api_key: "k",
      enabled: true,
    },
    judge: {
      adapter: "compatible",
      base_url: "https://api.example.com/v1",
      model: "judge-x",
      api_key: "k",
      enabled: false,
    },
    fallback: {
      adapter: "ollama",
      base_url: "http://127.0.0.1:11434",
      model: "fb-model",
      enabled: false,
    },
  });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.local.supports_image, true, "保存后必须保留看图能力声明");
  assert.equal(after.local.supports_think, false, "保存后必须保留思考能力声明");
  assert.equal(gateway.roleSupportsImage("local"), true);
  assert.equal(gateway.roleSupportsThink("local"), false);
});

test("未声明的角色按支持思考处理，不误伤既有配置", () => {
  const { gateway } = setup({ supports_think: undefined });
  assert.equal(gateway.roleSupportsThink("local"), true);
  assert.equal(gateway.roleSupportsThink("cloud"), true);
});
