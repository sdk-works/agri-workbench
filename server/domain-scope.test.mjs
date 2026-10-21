import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./test-helpers.mjs";
import { domains } from "./workspace.mjs";

function docPayload(name, domain, content = "番茄温度二十五度需要通风") {
  return {
    name,
    domain,
    base64: Buffer.from(content, "utf8").toString("base64"),
    source: "单元测试",
    tags: "",
  };
}

async function deptList(f) {
  return (await f.request("/departments", undefined, f.admin)).data.items;
}

async function setDepts(f, u, deptIds) {
  const res = await f.request(
    "/users",
    {
      id: u.user.id,
      username: u.user.username,
      name: u.user.name,
      role: u.user.role,
      dept_ids: deptIds,
      active: true,
    },
    f.admin,
  );
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res;
}

test("部门隔离：跨部门不能写、不能读、不能下载；管理员例外", async (t) => {
  const f = await fixture(t);
  const planting = await f.add("emp-planting", "employee", [domains[0]]);
  const iot = await f.add("emp-iot", "employee", [domains[1]]);
  const nobody = await f.add("emp-none", "employee", []);

  const own = await f.request(
    "/documents",
    docPayload("own.txt", domains[0]),
    planting.cookie,
  );
  assert.equal(own.status, 202, JSON.stringify(own.data));

  assert.equal(
    (
      await f.request(
        "/documents",
        docPayload("cross.txt", domains[1]),
        planting.cookie,
      )
    ).status,
    403,
    "跨部门上传必须被拒绝",
  );
  assert.equal(
    (
      await f.request(
        "/documents",
        docPayload("nodept.txt", domains[0]),
        nobody.cookie,
      )
    ).status,
    403,
    "未分配部门不能上传",
  );

  assert.equal(
    (
      await f.request(
        "/turns",
        { request_id: randomUUID(), question: "湿度怎么降", domain: domains[1] },
        planting.cookie,
      )
    ).status,
    403,
    "跨部门提问必须被拒绝",
  );
  assert.equal(
    (
      await f.request(
        "/turns",
        { request_id: randomUUID(), question: "湿度怎么降", domain: domains[0] },
        nobody.cookie,
      )
    ).status,
    403,
    "未分配部门不能提问",
  );

  const adminDoc = await f.request(
    "/documents",
    docPayload("admin.txt", domains[0]),
    f.admin,
  );
  assert.equal(adminDoc.status, 202);
  const id = adminDoc.data.document.id;
  const stored = await f.repo.get("documents", id);
  await f.repo.put("documents", {
    ...stored,
    status: "published",
    approved_text: "番茄温度二十五度需要通风",
  });

  const listSame = await f.request("/documents", undefined, planting.cookie);
  assert.ok(listSame.data.items.some((d) => d.id === id));

  const listOther = await f.request("/documents", undefined, iot.cookie);
  assert.equal(listOther.data.items.length, 0);
  assert.equal(
    (await f.request(`/documents/${id}`, undefined, iot.cookie)).status,
    404,
  );
  assert.equal(
    (await f.request(`/documents/${id}/original`, undefined, iot.cookie))
      .status,
    404,
  );
});

test("部门管理员：可读本部门未发布资料与评审入口", async (t) => {
  const f = await fixture(t);
  const manager = await f.add("mgr-planting", "manager", [domains[0]]);

  const doc = await f.request(
    "/documents",
    docPayload("pending.txt", domains[0]),
    f.admin,
  );
  assert.equal(doc.status, 202);
  const id = doc.data.document.id;

  const detail = await f.request(`/documents/${id}`, undefined, manager.cookie);
  assert.equal(detail.status, 200, "部门管理员应能读本部门待审资料");
  assert.equal(detail.data.status, "parsing");

  const list = await f.request("/documents", undefined, manager.cookie);
  assert.ok(list.data.items.some((d) => d.id === id));

  assert.equal(
    (await f.request("/reviews", undefined, manager.cookie)).status,
    200,
    "部门管理员应能进入本部门评审",
  );
});

test("调岗与撤权后，历史资料不再默认可见", async (t) => {
  const f = await fixture(t);
  const staff = await f.add("emp-move", "employee", [domains[0]]);
  const depts = await deptList(f);
  const d0 = depts.find((d) => d.name === domains[0]);
  const d1 = depts.find((d) => d.name === domains[1]);

  const up = await f.request(
    "/documents",
    docPayload("mine.txt", domains[0]),
    staff.cookie,
  );
  assert.equal(up.status, 202);
  const id = up.data.document.id;
  assert.equal(
    (await f.request(`/documents/${id}`, undefined, staff.cookie)).status,
    200,
  );

  await setDepts(f, staff, [d1.id]);
  assert.equal(
    (await f.request(`/documents/${id}`, undefined, staff.cookie)).status,
    404,
    "调岗后不能继续访问原部门资料",
  );
  const list1 = await f.request("/documents", undefined, staff.cookie);
  assert.equal(list1.data.items.length, 0);

  await setDepts(f, staff, []);
  assert.equal(
    (await f.request(`/documents/${id}`, undefined, staff.cookie)).status,
    404,
    "撤权后不能访问历史资料",
  );
  assert.equal(
    (
      await f.request(
        "/turns",
        { request_id: randomUUID(), question: "还能提问吗", domain: domains[0] },
        staff.cookie,
      )
    ).status,
    403,
  );
});

test("多部门账号：可访问授权部门，越界仍拒绝", async (t) => {
  const f = await fixture(t);
  const multi = await f.add("emp-multi", "employee", [domains[0], domains[1]]);

  for (const [i, d] of [domains[0], domains[1]].entries()) {
    const up = await f.request(
      "/documents",
      docPayload(`multi-${i}.txt`, d),
      multi.cookie,
    );
    assert.equal(up.status, 202, JSON.stringify(up.data));
  }
  assert.equal(
    (
      await f.request(
        "/documents",
        docPayload("multi-x.txt", domains[2]),
        multi.cookie,
      )
    ).status,
    403,
  );
});

test("部门改名/停用的一致性保护", async (t) => {
  const f = await fixture(t);
  await f.add("emp-planting", "employee", [domains[0]]);
  const depts = await deptList(f);
  const d0 = depts.find((d) => d.name === domains[0]);

  await f.request("/documents", docPayload("keep.txt", domains[0]), f.admin);
  assert.equal(
    (
      await f.request(
        "/departments",
        { id: d0.id, name: "种植管理-改名" },
        f.admin,
        "PUT",
      )
    ).status,
    409,
    "有数据的部门改名应被拒绝",
  );
  assert.equal(
    (
      await f.request(
        "/departments",
        { id: d0.id, active: false },
        f.admin,
        "PUT",
      )
    ).status,
    409,
    "仍有员工的部门停用应被拒绝",
  );

  const created = await f.request(
    "/departments",
    { name: "临时部门" },
    f.admin,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const renamed = await f.request(
    "/departments",
    { id: created.data.id, name: "临时部门改名" },
    f.admin,
    "PUT",
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
});

test("检索越权：只检索提问者本部门资料", async (t) => {
  const f = await fixture(t);
  const iot = await f.add("emp-iot", "employee", [domains[1]]);

  const doc = await f.request(
    "/documents",
    docPayload("secret.txt", domains[0], "紫甘蓝霜霉病防治需要控制湿度"),
    f.admin,
  );
  assert.equal(doc.status, 202);
  const id = doc.data.document.id;
  const stored = await f.repo.get("documents", id);
  await f.repo.put("documents", {
    ...stored,
    status: "published",
    approved_text: "紫甘蓝霜霉病防治需要控制湿度",
  });

  const turn = await f.turn(iot.cookie, "紫甘蓝霜霉病怎么防治", {
    domain: domains[1],
  });
  const saved = await f.repo.get("turns", turn.id);
  assert.ok(
    (saved.references || []).every((r) => r.document_id !== id),
    "不能检索到其他部门资料",
  );
  assert.equal((saved.references || []).length, 0);
});
