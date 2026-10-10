<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import {
  Sprout,
  MessageSquare,
  Library,
  ShieldCheck,
  Settings,
  Users,
  LogOut,
  Plus,
  Upload,
  RefreshCw,
  LayoutDashboard,
  ImagePlus,
} from "lucide-vue-next";
import { call, download } from "./workspace-api";
const user = ref(null),
  ready = ref(false),
  setup = ref(false),
  page = ref("chat"),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const login = ref({ username: "", name: "", password: "" }),
  domains = ["种植管理", "农业物联网", "农业销售"];
const conversations = ref([]),
  conversationId = ref(""),
  turns = ref([]),
  question = ref(""),
  domain = ref(domains[0]),
  draft = ref(null),
  pendingImage = ref(null),
  comments = ref({});
const reviews = ref([]),
  detail = ref(null),
  reviewForm = ref({}),
  showAnalysis = ref(false),
  reviewFilter = ref("pending");
const docs = ref([]),
  doc = ref(null),
  upload = ref({ domain: domains[0], source: "", tags: "" }),
  file = ref(null),
  docForm = ref({}),
  docQuestion = ref("");
const annotation = ref(null),
  annotationForm = ref({}),
  annotationEvidence = ref(""),
  suggested = ref(null);
const users = ref([]),
  account = ref({
    username: "",
    name: "",
    password: "",
    role: "employee",
    domains: [...domains],
    active: true,
  }),
  models = ref({}),
  rules = ref({}),
  blockRules = ref([]),
  ruleForm = ref({ name: "", kind: "keyword", pattern: "", action: "block", note: "" }),
  jobs = ref([]),
  metrics = ref(null),
  legacy = ref([]);
const expert = computed(() => ["expert", "admin"].includes(user.value?.role)),
  admin = computed(() => user.value?.role === "admin");
const annotationStatus = computed(() => {
  const a = annotation.value?.annotation;
  if (!a) return { class: "neutral", text: "未标注" };
  if (a.status === "approved")
    return { class: "success", text: `已确认 v${a.revision}` };
  return { class: "amber", text: `草稿 v${a.revision}` };
});
const roleNames = { employee: "普通员工", expert: "领域专家", admin: "管理员" };
const statusNames = {
  queued: "待处理",
  running: "处理中",
  deferred: "排队待分配",
  claimed: "已领取",
  awaiting_review: "待确认",
  approved: "已审核",
  excluded: "已排除",
  completed: "完成",
  partial: "单路可用",
  failed: "失败",
  generating: "正在回答",
  degraded: "本地降级",
  unavailable: "无法比较",
  parsing: "解析中",
  pending: "待审核",
  published: "已发布",
  rejected: "已退回",
  blocked: "被拦截",
};
const choices = {
  A: "采用 A",
  B: "采用 B",
  tie: "都可以",
  both_bad: "都不好",
  insufficient: "信息不足",
};
const nav = computed(() => [
  { id: "chat", label: "农业问答", icon: MessageSquare },
  { id: "documents", label: "知识资料", icon: Library },
  ...(expert.value
    ? [
        { id: "reviews", label: "专家评审", icon: ShieldCheck },
        { id: "metrics", label: "质量看板", icon: LayoutDashboard },
      ]
    : []),
  ...(admin.value
    ? [
        { id: "users", label: "员工管理", icon: Users },
        { id: "settings", label: "模型与规则", icon: Settings },
      ]
    : []),
]);
const title = computed(
  () => nav.value.find((n) => n.id === page.value)?.label || "农业问答",
);
const filteredReviews = computed(() =>
  reviews.value.filter(
    (r) =>
      reviewFilter.value === "all" ||
      !["approved", "excluded"].includes(r.status),
  ),
);
let timer,
  polling = false,
  disposed = false;
async function act(fn) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e.message;
    if (e.status === 401) user.value = null;
  } finally {
    busy.value = false;
  }
}
async function authenticate() {
  await act(async () => {
    if (setup.value) {
      await call("/auth/setup", login.value);
      setup.value = false;
    }
    user.value = (await call("/auth/login", login.value)).user;
    login.value.password = "";
    await refresh();
  });
}
async function logout() {
  await act(async () => {
    await call("/auth/logout", {});
    user.value = null;
    turns.value = [];
    conversations.value = [];
    detail.value = null;
    doc.value = null;
    conversationId.value = "";
    page.value = "chat";
  });
}
async function go(id) {
  page.value = id;
  error.value = "";
  notice.value = "";
  detail.value = null;
  doc.value = null;
  await act(refresh);
}
async function refresh() {
  if (!user.value) return;
  const identity = user.value.id,
    view = page.value,
    conv = conversationId.value;
  const current = () =>
    user.value?.id === identity &&
    page.value === view &&
    conversationId.value === conv;
  if (view === "chat") {
    const list = await call("/conversations");
    const response = conv
      ? await call("/turns?conversation_id=" + conv)
      : { items: [] };
    if (current()) {
      conversations.value = list.items;
      turns.value = response.items.sort((a, b) => a.sequence - b.sequence);
    }
  }
  if (view === "reviews") {
    const response = await call("/reviews");
    if (current()) reviews.value = response.items;
  }
  if (view === "documents") {
    const response = await call("/documents");
    if (current()) docs.value = response.items;
    if (doc.value?.status === "parsing") {
      const id = doc.value.id,
        response = await call("/documents/" + id);
      if (current() && doc.value?.id === id) {
        doc.value = response;
        docForm.value.text =
          response.approved_text || response.cleaned_text || "";
      }
    }
  }
  if (view === "users") {
    const response = await call("/users");
    if (current()) users.value = response.items;
  }
  if (view === "metrics") {
    const response = await call("/metrics");
    if (current()) metrics.value = response;
  }
  if (view === "settings") {
    const [m, r, br, j, l] = await Promise.all([
      call("/models"),
      call("/rules"),
      call("/block-rules"),
      call("/jobs"),
      call("/legacy"),
    ]);
    if (current()) {
      models.value = m.models;
      rules.value = r;
      blockRules.value = br.items;
      jobs.value = j.items;
      legacy.value = l.items;
    }
  }
}
async function poll() {
  if (polling || busy.value || !user.value) return;
  polling = true;
  try {
    if (["chat", "reviews", "documents"].includes(page.value)) await refresh();
  } catch (e) {
    if (!disposed) {
      error.value = e.message;
      if (e.status === 401) user.value = null;
    }
  } finally {
    polling = false;
  }
}
function newConversation() {
  conversationId.value = "";
  turns.value = [];
  question.value = "";
  draft.value = null;
}
async function selectConversation(c) {
  conversationId.value = c.id;
  domain.value = c.domain;
  await act(refresh);
}
async function pickImage(e) {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) {
    error.value = "图片不能超过 8 MB";
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type)) {
    error.value = "仅支持 PNG / JPG / WEBP / GIF 图片";
    return;
  }
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(Error("读取图片失败"));
    reader.readAsDataURL(f);
  });
  pendingImage.value = { data: base64, mime: f.type, name: f.name };
  draft.value = null;
}
function clearImage() {
  pendingImage.value = null;
  draft.value = null;
}
async function ask() {
  await act(async () => {
    if (
      !draft.value ||
      draft.value.question !== question.value ||
      draft.value.conversation_id !== conversationId.value ||
      Boolean(draft.value.image) !== Boolean(pendingImage.value)
    )
      draft.value = {
        request_id: crypto.randomUUID(),
        question: question.value,
        domain: domain.value,
        conversation_id: conversationId.value || undefined,
        image: pendingImage.value
          ? { data: pendingImage.value.data, mime: pendingImage.value.mime }
          : undefined,
      };
    const t = await call("/turns", draft.value);
    conversationId.value = t.conversation_id;
    question.value = "";
    pendingImage.value = null;
    draft.value = null;
    await refresh();
  });
}
async function feedback(t, choice) {
  await act(async () => {
    await call(`/turns/${t.id}/feedback`, {
      choice,
      comment: comments.value[t.id] || "",
    });
    notice.value = "已记录，谢谢你的反馈。";
    await refresh();
  });
}
async function openReview(r) {
  await act(async () => {
    detail.value = await call("/reviews/" + r.id);
    showAnalysis.value = false;
    const saved = detail.value.review;
    reviewForm.value = {
      answer: saved.expert?.answer || "",
      evidence: saved.expert?.evidence || "",
      notes: saved.expert?.notes || "",
      preferred: "",
      original_acceptable: false,
      issue_confirmed: false,
    };
  });
}
async function reviewAction(action) {
  await act(async () => {
    const r = detail.value.review;
    await call(`/reviews/${r.id}/${action}`, {
      ...reviewForm.value,
      revision: r.revision,
      reason: reviewForm.value.notes,
    });
    detail.value = await call("/reviews/" + r.id);
    await refresh();
    notice.value = "已保存处理结果。";
  });
}
async function exportSet(kind) {
  await act(async () => {
    const out = await call("/datasets/export", { kind });
    download(
      out.items.map((x) => JSON.stringify(x)).join("\n"),
      `agri-${kind}-${out.id}.jsonl`,
    );
    notice.value = `导出 ${out.items.length} 条，版本快照已保存。`;
  });
}
async function uploadFile() {
  await act(async () => {
    if (!file.value) throw Error("请选择文件");
    if (file.value.size > 8 * 1024 * 1024) throw Error("单个文件不能超过 8 MB");
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(Error("读取文件失败"));
      reader.readAsDataURL(file.value);
    });
    const out = await call("/documents", {
      ...upload.value,
      name: file.value.name,
      base64,
    });
    notice.value = out.duplicate
      ? "这份资料已上传，未重复创建。"
      : "原文件已保存，正在后台解析。";
    await refresh();
  });
}
async function openDoc(d) {
  await act(async () => {
    doc.value = await call("/documents/" + d.id);
    docForm.value = {
      text: doc.value.approved_text || doc.value.cleaned_text || "",
      evidence: doc.value.review?.evidence || "",
      checked: false,
      reason: "",
    };
    await loadAnnotation();
  });
}
async function loadAnnotation() {
  annotation.value = null;
  annotationEvidence.value = "";
  suggested.value = null;
  if (!mayReviewDoc(doc.value)) return;
  try {
    const a = await call(`/documents/${doc.value.id}/annotation`);
    annotation.value = a;
    annotationForm.value = a.annotation
      ? formFromFields(a.annotation.fields)
      : blankAnnotationForm();
  } catch {
    annotationForm.value = blankAnnotationForm();
  }
}
function blankAnnotationForm() {
  return {
    title: "",
    summary: "",
    knowledge_type: "",
    crop: "",
    variety: "",
    growth_stage: "",
    cultivation_method: "",
    region: "",
    greenhouse: "",
    applicable_conditions: "",
    exclusions: "",
    keywords: "",
    evidence_locations: "",
    verification_notes: "",
  };
}
function formFromFields(f) {
  const join = (arr) => (Array.isArray(arr) ? arr.join("\n") : "");
  return {
    title: f.title || "",
    summary: f.summary || "",
    knowledge_type: f.knowledge_type || "",
    crop: f.crop || "",
    variety: f.variety || "",
    growth_stage: f.growth_stage || "",
    cultivation_method: f.cultivation_method || "",
    region: f.region || "",
    greenhouse: f.greenhouse || "",
    applicable_conditions: join(f.applicable_conditions),
    exclusions: join(f.exclusions),
    keywords: join(f.keywords),
    evidence_locations: join(f.evidence_locations),
    verification_notes: join(f.verification_notes),
  };
}
function fieldsFromForm() {
  const fields = { ...annotationForm.value };
  for (const key of [
    "applicable_conditions",
    "exclusions",
    "keywords",
    "evidence_locations",
    "verification_notes",
  ]) {
    fields[key] = String(fields[key] || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30);
  }
  for (const key of [
    "title",
    "summary",
    "knowledge_type",
    "crop",
    "variety",
    "growth_stage",
    "cultivation_method",
    "region",
    "greenhouse",
  ]) {
    fields[key] = String(fields[key] || "").trim() || null;
  }
  return fields;
}
async function suggestAnnotation() {
  await act(async () => {
    suggested.value = await call(
      `/documents/${doc.value.id}/annotation/suggest`,
      {},
    );
    annotationForm.value = formFromFields(suggested.value.fields);
    notice.value = `已填入 AI 建议（${suggested.value.model}），请逐项核对，未提供的字段请保留为空。`;
  });
}
async function saveAnnotation() {
  await act(async () => {
    const fields = fieldsFromForm();
    if (!fields.title) throw Error("标注标题不能为空");
    const a = annotation.value?.annotation || {
      revision: 0,
      document_revision: doc.value.revision,
    };
    const saved = await call(`/documents/${doc.value.id}/annotation`, {
      revision: a.revision,
      document_revision: doc.value.revision,
      fields,
    });
    annotation.value = { annotation: saved, stale: false };
    notice.value = "标注草稿已保存。";
  });
}
async function approveAnnotation() {
  await act(async () => {
    const a = annotation.value?.annotation;
    if (!a) throw Error("请先保存标注草稿");
    await call(`/documents/${doc.value.id}/annotation/approve`, {
      revision: a.revision,
      checked: true,
      evidence: annotationEvidence.value.trim() || "已对照原文核实",
    });
    await loadAnnotation();
    notice.value = "标注已确认，可用于知识资产包导出。";
  });
}
function mayReviewDoc(d) {
  return (
    admin.value ||
    (user.value?.role === "expert" && user.value.domains.includes(d.domain))
  );
}
async function documentAction(action) {
  await act(async () => {
    doc.value = await call(`/documents/${doc.value.id}/${action}`, {
      ...docForm.value,
      revision: doc.value.revision,
      ...(doc.value.blocking?.status === "blocked"
        ? { confirm_block: true }
        : {}),
    });
    notice.value = "资料处理已保存。";
    await refresh();
  });
}
async function makeTrainingQuestion() {
  await act(async () => {
    const t = await call(`/documents/${doc.value.id}/training-question`, {
      question: docQuestion.value,
      request_id: crypto.randomUUID(),
    });
    page.value = "chat";
    conversationId.value = t.conversation_id;
    await refresh();
  });
}
function editUser(u) {
  account.value = { ...u, domains: [...u.domains], password: "" };
}
function resetUser() {
  account.value = {
    username: "",
    name: "",
    password: "",
    role: "employee",
    domains: [...domains],
    active: true,
  };
}
async function saveUser() {
  await act(async () => {
    await call("/users", account.value);
    resetUser();
    await refresh();
    notice.value = "员工账号已保存。";
  });
}
async function saveModel(role) {
  await act(async () => {
    models.value = (
      await call("/models", { [role]: models.value[role] })
    ).models;
    notice.value = "模型配置已保存，新任务使用新配置。";
  });
}
async function saveRules() {
  await act(async () => {
    rules.value = await call("/rules", rules.value);
    notice.value = "分流规则已保存。";
  });
}
async function saveBlockRule() {
  await act(async () => {
    if (!ruleForm.value.name.trim() || !ruleForm.value.pattern.trim())
      throw Error("请填写规则名称和规则内容");
    await call("/block-rules", ruleForm.value);
    ruleForm.value = {
      name: "",
      kind: "keyword",
      pattern: "",
      action: "block",
      note: "",
    };
    blockRules.value = (await call("/block-rules")).items;
    notice.value = "拦截规则已保存，新上传资料立即生效。";
  });
}
async function updateBlockRule(r) {
  await act(async () => {
    await call(`/block-rules/${r.id}`, r);
    blockRules.value = (await call("/block-rules")).items;
    notice.value = "规则已更新。";
  });
}
async function deleteBlockRule(r) {
  await act(async () => {
    await call(`/block-rules/${r.id}`, {}, "DELETE");
    blockRules.value = (await call("/block-rules")).items;
    notice.value = "规则已删除。";
  });
}
async function retryJob(j) {
  await act(async () => {
    await call(`/jobs/${j.id}/retry`, {});
    jobs.value = (await call("/jobs")).items;
    notice.value = "裁判已重新排队。";
  });
}
onMounted(async () => {
  try {
    const status = await call("/auth/status");
    setup.value = status.setup_required;
    user.value = status.user;
    if (user.value) await refresh();
  } catch (e) {
    error.value = e.message;
  } finally {
    ready.value = true;
  }
  timer = setInterval(poll, 3000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>

<template>
  <div v-if="!user" class="login-screen">
    <section class="login-card">
      <div class="brand-line">
        <Sprout :size="32" /><strong>青禾 · 农业 AI 工作台</strong>
      </div>
      <p class="subtle">日常使用积累经验，让专家把关农业知识。</p>
      <h1>
        {{ !ready ? "连接工作台…" : setup ? "创建管理员账号" : "欢迎回来" }}
      </h1>
      <form v-if="ready" @submit.prevent="authenticate">
        <label
          >账号<input
            v-model="login.username"
            autocomplete="username"
            required
            minlength="3"
            placeholder="字母、数字或下划线" /></label
        ><label v-if="setup"
          >显示名<input
            v-model="login.name"
            placeholder="可用昵称或工号" /></label
        ><label
          >密码<input
            v-model="login.password"
            type="password"
            :autocomplete="setup ? 'new-password' : 'current-password'"
            required
            minlength="10"
            maxlength="128"
        /></label>
        <p v-if="setup" class="subtle">
          首次创建管理员，之后由管理员添加员工和专家。反馈时无需再填写姓名。
        </p>
        <button class="primary" :disabled="busy">
          {{ setup ? "创建并进入" : "登录" }}
        </button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
  </div>
  <div v-else class="wb-layout">
    <aside class="wb-sidebar">
      <div class="brand-line">
        <Sprout :size="27" /><strong
          >青禾 <small>AGRI INTELLIGENCE</small></strong
        >
      </div>
      <div class="workspace-label">
        农业 AI 工作空间<small>问答 · 知识 · 专家协作</small>
      </div>
      <nav>
        <button
          v-for="n in nav"
          :key="n.id"
          :class="{ active: page === n.id }"
          @click="go(n.id)"
        >
          <component :is="n.icon" :size="19" />{{ n.label }}
        </button>
      </nav>
      <div class="wb-profile">
        <strong>{{ user.name }}</strong
        ><span>{{ roleNames[user.role] }}</span
        ><button @click="logout"><LogOut :size="16" />退出登录</button>
      </div>
    </aside>
    <main class="wb-main">
      <header class="wb-top">
        <span
          >农业 AI 平台 / <strong>{{ title }}</strong></span
        ><span class="badge success">{{ roleNames[user.role] }}</span>
      </header>
      <div class="wb-content">
        <div class="heading">
          <div>
            <div class="eyebrow">AGRICULTURAL INTELLIGENCE</div>
            <h1>{{ title }}</h1>
          </div>
          <button class="outline" :disabled="busy" @click="act(refresh)">
            <RefreshCw :size="16" />刷新
          </button>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="notice" class="success-message" role="status">{{ notice }}</p>
        <template v-if="page === 'chat'">
          <p class="subtle intro">
            正常提问，随手选择更有帮助的回答。无需填写标注表，也可以直接继续聊。
          </p>
          <div class="chat-layout">
            <section class="panel conversation-list">
              <button class="primary" @click="newConversation">
                <Plus :size="16" />新会话</button
              ><button
                v-for="c in conversations"
                :key="c.id"
                :class="['conversation', { selected: c.id === conversationId }]"
                @click="selectConversation(c)"
              >
                <strong>{{ c.title }}</strong
                ><small>{{ c.domain }}</small>
              </button>
              <p v-if="!conversations.length" class="subtle">
                你的会话将保存在这里。
              </p>
            </section>
            <div class="conversation-body">
              <section v-if="!turns.length" class="panel welcome">
                <Sprout :size="36" />
                <h2>今天有什么农业问题？</h2>
                <p>
                  描述作物、生育期、现场环境和你的目标，能帮助模型给出更合适的建议。
                </p>
              </section>
              <article v-for="t in turns" :key="t.id" class="turn">
                <div class="question-bubble">
                  <small
                    >第 {{ t.sequence }} 轮 · {{ statusNames[t.status] }}</small
                  >
                  <p>{{ t.question }}</p>
                </div>
                <div class="wb-answers">
                  <section
                    v-for="c in t.candidates"
                    :key="c.label"
                    class="panel candidate"
                  >
                    <h3>
                      <span class="letter">{{ c.label }}</span
                      >回答 {{ c.label
                      }}<small>{{
                        c.model
                          ? `${c.provider === "local" ? "本地" : "云端"} · ${c.model}`
                          : "来源暂隐藏"
                      }}</small>
                    </h3>
                    <p class="answer-content">
                      {{
                        c.status === "pending"
                          ? "正在生成，请稍候…"
                          : c.status === "failed"
                            ? c.error
                            : c.text
                      }}
                    </p>
                  </section>
                </div>
                <details v-if="t.references?.length" class="references">
                  <summary>
                    本轮参考了 {{ t.references.length }} 个已审核资料片段
                  </summary>
                  <p v-for="r in t.references">
                    {{ r.name }} · v{{ r.version }} · {{ r.location }}
                  </p>
                </details>
                <div v-if="t.status !== 'generating'" class="feedback-bar">
                  <span>哪个更有帮助？</span
                  ><button
                    v-for="(label, key) in choices"
                    :key="key"
                    :class="['choice', { chosen: t.feedback?.choice === key }]"
                    :disabled="
                      busy ||
                      (['A', 'B'].includes(key) &&
                        !t.candidates.some(
                          (c) => c.label === key && c.status === 'completed',
                        ))
                    "
                    @click="feedback(t, key)"
                  >
                    {{ label }}
                  </button>
                  <details>
                    <summary>补充意见（选填）</summary>
                    <textarea
                      v-model="comments[t.id]"
                      maxlength="2000"
                      rows="2"
                      placeholder="例如：缺少具体适用条件。填写后点击上面的选择保存。"
                    />
                  </details>
                </div>
              </article>
              <form class="panel composer-v3" @submit.prevent="ask">
                <label v-if="!conversationId"
                  >问题领域<select v-model="domain">
                    <option v-for="d in domains">{{ d }}</option>
                  </select></label
                ><label
                  >{{ turns.length ? "继续追问" : "你的问题"
                  }}<textarea
                    v-model="question"
                    rows="3"
                    maxlength="4000"
                    required
                    placeholder="例如：大棚湿度持续偏高，调整通风前需要检查哪些数据？"
                  />
                </label>
                <div v-if="pendingImage" class="composer-image">
                  <img
                    :src="`data:${pendingImage.mime};base64,${pendingImage.data}`"
                    alt="提问图片"
                  />
                  <span>{{ pendingImage.name }}</span>
                  <button
                    type="button"
                    class="text-button"
                    @click="clearImage"
                  >
                    移除图片
                  </button>
                </div>
                <div class="form-bottom">
                  <span class="image-pick">
                    <label class="inline-check"
                      ><input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        @change="pickImage"
                      /><ImagePlus :size="16" />附图片（PNG/JPG/WEBP/GIF，≤8MB，随问题发给模型）</label
                    >
                  </span>
                  <small
                    >追问使用你采用的回答；未选择时优先沿用本地有效回答。选择修改不改写已生成的历史。</small
                  ><button
                    class="primary"
                    :disabled="
                      busy ||
                      !question.trim() ||
                      turns.some((t) => t.status === 'generating')
                    "
                  >
                    发送问题
                  </button>
                </div>
              </form>
            </div>
          </div>
        </template>
        <template v-if="page === 'reviews' && expert">
          <p class="subtle intro">
            集中处理实质分歧、负面反馈、关键操作和抽查案例。普通相似回答不常规送审。
          </p>
          <div v-if="admin" class="toolbar">
            <button
              v-for="kind in ['sft', 'dpo', 'eval']"
              class="outline"
              :disabled="busy"
              @click="exportSet(kind)"
            >
              导出 {{ kind.toUpperCase() }}
            </button>
          </div>
          <template v-if="detail"
            ><button class="text-button" @click="detail = null">
              ← 返回队列
            </button>
            <section class="panel block">
              <h2>{{ detail.review.question }}</h2>
              <p class="subtle">
                {{ detail.review.domain }} ·
                {{ statusNames[detail.review.status] }} · 合并
                {{ detail.review.turn_ids.length }} 次 · v{{
                  detail.review.revision
                }}
              </p>
              <div class="tags">
                <span
                  v-for="reason in detail.review.reasons"
                  class="badge amber"
                  >{{ reason }}</span
                >
              </div>
              <p>
                {{
                  detail.review.critical
                    ? "该案例需另一位领域专家复审。"
                    : "常规案例可由当前专家确认，后续通过抽查检查质量。"
                }}
              </p>
              <button
                class="outline"
                :disabled="
                  busy ||
                  ['approved', 'excluded'].includes(detail.review.status)
                "
                @click="reviewAction('claim')"
              >
                领取任务（30 分钟）
              </button>
            </section>
            <div class="wb-answers">
              <section
                v-for="c in detail.turn.candidates"
                class="panel candidate"
              >
                <h3>回答 {{ c.label }}</h3>
                <p class="answer-content">{{ c.text || c.error }}</p>
                <button
                  class="text-button"
                  :disabled="
                    ['approved', 'excluded'].includes(detail.review.status)
                  "
                  @click="reviewForm.answer = c.text"
                >
                  用此回答作为修订起点
                </button>
              </section>
            </div>
            <details v-if="detail.related.length" class="panel block">
              <summary>查看合并案例的不同回答</summary>
              <div v-for="t in detail.related">
                <strong>{{ t.question }}</strong>
                <p v-for="c in t.candidates" class="answer-content">
                  {{ c.label }}：{{ c.text || c.error }}
                </p>
              </div>
              <p class="subtle">
                本次审核仅发布主案例，其他出现记录用于辅助判断。
              </p>
            </details>
            <section class="panel block">
              <button class="outline" @click="showAnalysis = !showAnalysis">
                {{ showAnalysis ? "收起" : "查看" }} AI 差异分析与来源
              </button>
              <div v-if="showAnalysis">
                <p v-for="c in detail.turn.candidates">
                  {{ c.label }}：{{ c.provider }} / {{ c.model || "失败" }}
                </p>
                <p>
                  裁判：{{ statusNames[detail.turn.judge.status] }}
                  {{ detail.turn.judge.error?.message }}
                </p>
                <template v-if="detail.turn.judge.result"
                  ><p>
                    模型：{{ detail.turn.judge.result.model }} ·
                    {{
                      detail.turn.judge.result.degraded
                        ? "降级参考，不代表审核通过"
                        : ""
                    }}{{
                      detail.turn.judge.result.self_judging
                        ? " · 与回答模型相同，可能有自评偏差"
                        : ""
                    }}
                  </p>
                  <p>{{ detail.turn.judge.result.reason }}</p>
                  <p>
                    依据状态：{{ detail.turn.judge.result.evidence_status }}
                  </p>
                  <ul>
                    <li
                      v-for="s in [
                        ...detail.turn.judge.result.differences,
                        ...detail.turn.judge.result.conflicts,
                        ...detail.turn.judge.result.missing_conditions,
                      ]"
                    >
                      {{ s }}
                    </li>
                  </ul></template
                >
              </div>
              <details>
                <summary>问题依据与资料片段</summary>
                <p
                  v-for="(m, i) in detail.turn.context"
                  :key="i"
                  class="answer-content"
                >
                  {{ m.role === "user" ? "提问" : "此前采用的回答" }}：{{
                    m.content
                  }}
                </p>
                <p v-for="r in detail.turn.references" class="answer-content">
                  {{ r.name }} · {{ r.location }}：{{ r.content }}
                </p>
                <p v-if="!detail.turn.references.length">
                  本轮没有检索到已审核资料，请独立核实。
                </p>
              </details>
            </section>
            <section class="panel block">
              <h2>专家答案</h2>
              <details v-if="detail.versions?.length">
                <summary>
                  已保存的修订历史（{{ detail.versions.length }} 版）
                </summary>
                <div v-for="v in detail.versions">
                  <strong>v{{ v.revision }} · {{ v.expert.at }}</strong>
                  <p class="answer-content">{{ v.expert.answer }}</p>
                  <p>{{ v.expert.evidence }}</p>
                </div>
              </details>
              <label
                >确认原答案或修订<textarea
                  v-model="reviewForm.answer"
                  rows="7"
                  :disabled="
                    ['approved', 'excluded'].includes(detail.review.status)
                  "
                /></label
              ><label
                >依据与适用条件<textarea
                  v-model="reviewForm.evidence"
                  rows="3"
                /></label
              ><label
                >优化意见 / 排除原因<textarea
                  v-model="reviewForm.notes"
                  rows="2"
                />
              </label>
              <div
                class="toolbar"
                v-if="!['approved', 'excluded'].includes(detail.review.status)"
              >
                <button
                  class="outline"
                  :disabled="busy || !reviewForm.notes.trim()"
                  @click="reviewAction('exclude')"
                >
                  排除案例</button
                ><button
                  class="primary"
                  :disabled="
                    busy ||
                    !reviewForm.answer.trim() ||
                    !reviewForm.evidence.trim()
                  "
                  @click="reviewAction('save')"
                >
                  保存答案
                </button>
              </div>
              <div
                v-if="detail.review.status === 'awaiting_review'"
                class="approval"
              >
                <p>确认的是已保存的答案版本；修改后请先保存。</p>
                <label
                  >原始回答偏好<select v-model="reviewForm.preferred">
                    <option value="">仅标准答案，不生成 DPO</option>
                    <option value="A">原始 A 合格且优于 B</option>
                    <option value="B">原始 B 合格且优于 A</option>
                  </select></label
                ><label v-if="reviewForm.preferred" class="inline-check"
                  ><input
                    type="checkbox"
                    v-model="reviewForm.original_acceptable"
                  />已核实原始优选答案本身正确</label
                ><label class="inline-check"
                  ><input
                    type="checkbox"
                    v-model="reviewForm.issue_confirmed"
                  />本次确实发现了事实或实质质量问题（用于统计）</label
                ><button
                  class="primary"
                  :disabled="
                    busy ||
                    (!!reviewForm.preferred && !reviewForm.original_acceptable)
                  "
                  @click="reviewAction('approve')"
                >
                  确认已保存版本
                </button>
              </div>
              <p v-if="detail.review.approval" class="subtle">
                审核时间：{{ detail.review.approval.at }} · v{{
                  detail.review.approval.revision
                }}
              </p>
            </section>
          </template>
          <section v-else class="panel block">
            <div class="toolbar">
              <h2>领域评审队列</h2>
              <select v-model="reviewFilter">
                <option value="pending">待处理</option>
                <option value="all">全部</option>
              </select>
            </div>
            <button
              v-for="r in filteredReviews"
              class="list-row"
              @click="openReview(r)"
            >
              <div>
                <strong>{{ r.question }}</strong
                ><small
                  >{{ r.domain }} · {{ r.reasons.join(" / ") }} ·
                  {{ r.turn_ids.length }} 次出现</small
                >
              </div>
              <span class="badge neutral">{{ statusNames[r.status] }}</span>
            </button>
            <p v-if="!filteredReviews.length" class="empty">
              暂无需要你处理的案例。
            </p>
          </section>
        </template>
        <template v-if="page === 'documents'">
          <p class="subtle intro">
            上传经验资料，解析清洗后交由领域专家审核。只有已发布文本参与问答检索。
          </p>
          <section class="panel block" v-if="!doc">
            <h2>上传资料</h2>
            <div class="field-grid">
              <label
                >领域<select v-model="upload.domain">
                  <option v-for="d in domains">{{ d }}</option>
                </select></label
              ><label
                >来源 / 版本<input
                  v-model="upload.source"
                  placeholder="如：园区种植 SOP 2026.10" /></label
              ><label
                >农业标签<input
                  v-model="upload.tags"
                  placeholder="作物、品种、生育期、棚号" /></label
              ><label
                >文件<input
                  type="file"
                  accept=".txt,.md,.csv,.jsonl,.docx,.pdf,.xlsx"
                  @change="file = $event.target.files[0]"
              /></label>
            </div>
            <p class="subtle">
              支持 TXT、MD、CSV、JSONL、DOCX、文字 PDF、XLSX，单个最大 8
              MB。扫描 PDF 需先 OCR。
            </p>
            <button
              class="primary"
              :disabled="busy || !file"
              @click="uploadFile"
            >
              <Upload :size="16" />上传并清洗
            </button>
          </section>
          <template v-if="doc"
            ><button class="text-button" @click="doc = null">← 返回资料</button>
            <section class="panel block">
              <h2>{{ doc.name }}</h2>
              <p>
                {{ statusNames[doc.status] }} · {{ doc.domain }} ·
                {{ doc.source }} · v{{ doc.revision }}
              </p>
              <p class="subtle">标签：{{ doc.tags || "未填写" }}</p>
              <details v-if="doc.versions?.length">
                <summary>已发布版本（{{ doc.versions.length }} 版）</summary>
                <div v-for="v in doc.versions">
                  <strong>v{{ v.revision }} · {{ v.review.at }}</strong>
                  <pre class="document-text">{{ v.text }}</pre>
                </div>
              </details>
              <a
                v-if="doc.owner === user.id || mayReviewDoc(doc)"
                class="text-button"
                :href="`/api/v2/documents/${doc.id}/original`"
                >下载原文件</a
              >
              <p class="error" v-if="doc.error">{{ doc.error }}</p>
              <p v-for="w in doc.warnings" class="warning">{{ w }}</p>
              <p v-if="doc.near_duplicates?.length" class="warning">
                疑似相似资料：{{
                  doc.near_duplicates.map((d) => d.name).join("、")
                }}；请人工核实。
              </p>
              <p v-if="doc.blocking" class="warning">
                {{
                  doc.blocking.status === "blocked"
                    ? "被拦截规则命中，暂不能发布，需人工核实后处理"
                    : "命中提示规则，发布前请留意"
                }}：{{
                  doc.blocking.hits
                    .map((h) => `「${h.name}」命中「${h.matched}」`)
                    .join("、")
                }}
              </p>
              <details v-if="doc.cleaned_text">
                <summary>查看自动清洗结果（含原始位置）</summary>
                <pre class="document-text">{{ doc.cleaned_text }}</pre>
              </details>
              <template
                v-if="
                  mayReviewDoc(doc) &&
                  ['pending', 'published', 'rejected', 'blocked'].includes(
                    doc.status,
                  )
                "
                ><p v-if="doc.status === 'blocked'" class="warning">
                  发布或退回将视为人工处理被拦截资料，处理后拦截标记清除。
                </p>
                <label
                  >审核文本<textarea v-model="docForm.text" rows="14" /></label
                ><label
                  >来源核实与适用条件<textarea
                    v-model="docForm.evidence"
                    rows="2"
                  /></label
                ><label class="inline-check"
                  ><input
                    v-model="docForm.checked"
                    type="checkbox"
                  />已核实资料来源、适用范围及敏感信息</label
                ><button
                  class="primary"
                  :disabled="
                    busy ||
                    !docForm.checked ||
                    !docForm.text ||
                    !docForm.evidence
                  "
                  @click="documentAction('publish')"
                >
                  审核并发布新版本</button
                ><label>退回原因<input v-model="docForm.reason" /></label
                ><button
                  class="outline"
                  :disabled="busy || !docForm.reason"
                  @click="documentAction('reject')"
                >
                  退回资料
                </button>
                <div v-if="doc.status === 'published'" class="approval">
                  <label
                    >根据这份资料提出一个案例问题<textarea
                      v-model="docQuestion"
                      rows="2"
                      maxlength="4000"
                    /></label
                  ><button
                    class="outline"
                    :disabled="busy || !docQuestion.trim()"
                    @click="makeTrainingQuestion"
                  >
                    生成候选问答
                  </button>
                  <p class="subtle">问答仍需经过专家审核才能进入训练集。</p>
                </div></template
              >
              <template
                v-if="
                  mayReviewDoc(doc) &&
                  ['pending', 'published', 'rejected', 'blocked'].includes(
                    doc.status,
                  )
                "
                ><section class="panel block">
                  <div class="toolbar">
                    <h2>结构化农业标注</h2>
                    <span
                      class="badge"
                      :class="annotationStatus.class"
                      >{{ annotationStatus.text }}</span
                    >
                  </div>
                  <p class="subtle">
                    用统一字段描述每条知识：作物、生育期、栽培方式、适用条件、来源位置与核实状态。原文没有的信息保留为空（未提供），不要猜测。
                  </p>
                  <button
                    class="outline"
                    :disabled="busy || suggesting"
                    @click="suggestAnnotation"
                  >
                    生成 AI 建议标注
                  </button>
                  <p v-if="suggested" class="subtle">
                    已按 AI 建议（{{ suggested.model }}，基于
                    {{ suggested.source_used === "cleaned" ? "清洗文本" : "审核文本"
                    }}）填入表单，请逐项核对。
                  </p>
                  <div class="field-grid">
                    <label
                      >标题（必填）<input
                        v-model="annotationForm.title"
                        maxlength="200" /></label
                    ><label
                      >知识类型<select v-model="annotationForm.knowledge_type">
                        <option value="">未提供</option>
                        <option
                          v-for="k in [
                            '种植知识',
                            '操作规程',
                            '设备说明',
                            '销售知识',
                            '案例记录',
                          ]"
                        >
                          {{ k }}
                        </option>
                      </select></label
                    ><label
                      >作物<input
                        v-model="annotationForm.crop"
                        maxlength="120" /></label
                    ><label
                      >品种<input
                        v-model="annotationForm.variety"
                        maxlength="120" /></label
                    ><label
                      >生育期<input
                        v-model="annotationForm.growth_stage"
                        maxlength="120" /></label
                    ><label
                      >栽培方式<input
                        v-model="annotationForm.cultivation_method"
                        maxlength="200" /></label
                    ><label
                      >地区<input
                        v-model="annotationForm.region"
                        maxlength="200" /></label
                    ><label
                      >大棚 / 设施<input
                        v-model="annotationForm.greenhouse"
                        maxlength="120"
                    /></label>
                  </div>
                  <label
                    >要点概述<textarea
                      v-model="annotationForm.summary"
                      rows="2"
                      maxlength="4000" /></label
                  ><label
                    >适用条件（每行一条）<textarea
                      v-model="annotationForm.applicable_conditions"
                      rows="2" /></label
                  ><label
                    >不适用 / 排除情况（每行一条）<textarea
                      v-model="annotationForm.exclusions"
                      rows="2" /></label
                  ><label
                    >关键词（每行一条）<textarea
                      v-model="annotationForm.keywords"
                      rows="2" /></label
                  ><label
                    >来源位置（段落 / 片段，每行一条）<textarea
                      v-model="annotationForm.evidence_locations"
                      rows="2" /></label
                  ><label
                    >待核实事项（每行一条）<textarea
                      v-model="annotationForm.verification_notes"
                      rows="2" /></label
                  >
                  <div class="button-row">
                    <button
                      class="primary"
                      :disabled="busy || !annotationForm.title"
                      @click="saveAnnotation"
                    >
                      保存草稿
                    </button>
                    <button
                      class="outline"
                      :disabled="busy || !annotation?.annotation"
                      @click="approveAnnotation"
                    >
                      确认标注
                    </button>
                    <label class="inline-check"
                      ><input
                        v-model="annotationEvidence"
                      />已对照原文核实，未提供的字段未被猜测</label
                    >
                  </div>
                  <p v-if="annotation?.stale" class="warning">
                    资料已更新版本，需重新核对标注后再确认。
                  </p>
                </section></template
              >
              <pre v-else-if="doc.approved_text" class="document-text">{{
                doc.approved_text
              }}</pre>
            </section></template
          >
          <section v-else class="panel block">
            <h2>资料库</h2>
            <button class="list-row" v-for="d in docs" @click="openDoc(d)">
              <div>
                <strong>{{ d.name }}</strong
                ><small
                  >{{ d.domain }} · {{ d.source }} ·
                  {{ Math.ceil(d.size / 1024) }} KB</small
                >
              </div>
              <span class="badge neutral">{{ statusNames[d.status] }}</span>
            </button>
            <p v-if="!docs.length" class="empty">还没有可见资料。</p>
          </section>
        </template>
        <template v-if="page === 'users' && admin"
          ><section class="panel block">
            <h2>{{ account.id ? "修改员工" : "添加员工" }}</h2>
            <form @submit.prevent="saveUser">
              <div class="field-grid">
                <label
                  >登录账号<input v-model="account.username" required /></label
                ><label
                  >显示名<input
                    v-model="account.name"
                    placeholder="昵称或工号" /></label
                ><label
                  >{{ account.id ? "新密码（留空不改）" : "初始密码"
                  }}<input
                    v-model="account.password"
                    type="password"
                    autocomplete="new-password"
                    :required="!account.id"
                    minlength="10"
                    maxlength="128" /></label
                ><label
                  >身份<select v-model="account.role">
                    <option v-for="(label, key) in roleNames" :value="key">
                      {{ label }}
                    </option>
                  </select></label
                >
              </div>
              <div class="toolbar">
                <label v-for="d in domains" class="inline-check"
                  ><input
                    type="checkbox"
                    v-model="account.domains"
                    :value="d"
                  />{{ d }}</label
                >
              </div>
              <label class="inline-check"
                ><input
                  type="checkbox"
                  v-model="account.active"
                />启用账号</label
              >
              <div class="toolbar">
                <button class="primary" :disabled="busy">保存账号</button
                ><button type="button" class="outline" @click="resetUser">
                  清空
                </button>
              </div>
            </form>
          </section>
          <section class="panel block">
            <h2>员工列表</h2>
            <button v-for="u in users" class="list-row" @click="editUser(u)">
              <div>
                <strong>{{ u.name }} · {{ u.username }}</strong
                ><small>{{ u.domains.join("、") }}</small>
              </div>
              <span
                >{{ roleNames[u.role] }} ·
                {{ u.active ? "启用" : "停用" }}</span
              >
            </button>
          </section></template
        >
        <template v-if="page === 'settings' && admin"
          ><p class="subtle intro">
            回答和裁判分别配置。密钥仅保存在服务器，不回传浏览器。兼容接口填写包含
            /v1 等前缀的基础地址，不含 /chat/completions。
          </p>
          <section v-for="(model, role) in models" class="panel block">
            <h2>
              {{
                {
                  local: "本地回答",
                  cloud: "云端回答",
                  judge: "独立 AI 裁判",
                  fallback: "备用本地裁判",
                }[role]
              }}
            </h2>
            <p class="subtle">
              {{
                model.configured
                  ? "已配置，实际连通性以调用结果为准"
                  : "待配置"
              }}{{ role === "judge" ? "；建议使用不同于回答模型的模型" : "" }}
            </p>
            <div class="field-grid">
              <label
                >接口类型<select v-model="model.adapter">
                  <option value="ollama">Ollama</option>
                  <option value="compatible">OpenAI 兼容格式</option>
                </select></label
              ><label
                >基础地址<input
                  v-model="model.base_url"
                  placeholder="https://供应商地址/v1" /></label
              ><label>模型名称<input v-model="model.model" /></label
              ><label v-if="model.adapter === 'compatible'"
                >API 密钥<input
                  v-model="model.api_key"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="
                    model.key_configured ? '已保存，留空不修改' : '尚未配置'
                  "
              /></label>
            </div>
            <div class="field-grid">
              <label
                >输入单价（元 / 百万 token，选填）<input
                  v-model="model.input_price"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="留空不估算" /></label
              ><label
                >输出单价（元 / 百万 token，选填）<input
                  v-model="model.output_price"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="留空不估算"
              /></label>
            </div>
            <label v-if="role === 'fallback'" class="inline-check"
              ><input
                type="checkbox"
                v-model="model.enabled"
              />云端裁判失败后启用（结果始终标记为降级）</label
            ><label v-if="model.key_configured" class="inline-check"
              ><input
                type="checkbox"
                v-model="model.clear_key"
              />清除已保存密钥</label
            ><button class="primary" :disabled="busy" @click="saveModel(role)">
              保存此配置
            </button>
          </section>
          <section class="panel block">
            <h2>自动分流规则</h2>
            <div class="field-grid">
              <label
                >普通样本抽查比例（0–1）<input
                  type="number"
                  v-model.number="rules.sample_rate"
                  min="0"
                  max="1"
                  step="0.01" /></label
              ><label
                >每日普通新评审预算<input
                  type="number"
                  v-model.number="rules.review_daily_limit"
                  min="1"
                  max="1000" /></label
              ><label
                >云端裁判最多尝试次数<input
                  type="number"
                  v-model.number="rules.judge_attempts"
                  min="1"
                  max="5"
              /></label>
            </div>
            <p class="subtle">
              关键冲突和操作不受普通预算限制；超额案例保留在待分配队列。
            </p>
            <button class="primary" :disabled="busy" @click="saveRules">
              保存分流规则
            </button>
          </section>
          <section class="panel block">
            <h2>入库拦截规则</h2>
            <p class="subtle">
              资料上传清洗完成后自动匹配；命中「拦截」的文档不能发布，需专家人工核实后处理；命中「提示」仅标记提醒。关键词按空格或逗号分隔，任一命中即触发。
            </p>
            <div class="field-grid">
              <label
                >规则名称<input v-model="ruleForm.name" placeholder="如：联系方式泄露" /></label
              ><label
                >类型<select v-model="ruleForm.kind">
                  <option value="keyword">关键词</option>
                  <option value="regex">正则表达式</option>
                </select></label
              ><label
                >规则内容<input
                  v-model="ruleForm.pattern"
                  placeholder="关键词用空格或逗号分隔；正则直接填写表达式" /></label
              ><label
                >命中动作<select v-model="ruleForm.action">
                  <option value="block">拦截（不能发布）</option>
                  <option value="flag">提示（仅标记）</option>
                </select></label
              ><label
                >备注（选填）<input v-model="ruleForm.note" /></label
              >
            </div>
            <button
              class="primary"
              :disabled="busy || !ruleForm.name.trim() || !ruleForm.pattern.trim()"
              @click="saveBlockRule"
            >
              添加规则
            </button>
            <div v-for="r in blockRules" class="list-row">
              <div>
                <strong>{{ r.name }}</strong
                ><small
                  >{{ r.kind === "regex" ? "正则" : "关键词" }} ·
                  {{ r.action === "block" ? "拦截" : "提示" }} ·
                  {{ r.enabled ? "启用" : "停用" }} · {{ r.pattern }}
                  {{ r.note ? "· " + r.note : "" }}</small
                >
              </div>
              <button
                class="outline"
                :disabled="busy"
                @click="
                  r.enabled = !r.enabled;
                  updateBlockRule(r);
                "
              >
                {{ r.enabled ? "停用" : "启用" }}
              </button>
              <button
                class="outline"
                :disabled="busy"
                @click="deleteBlockRule(r)"
              >
                删除
              </button>
            </div>
            <p v-if="!blockRules.length" class="empty">
              暂无拦截规则。未配置规则时资料不会触发拦截。
            </p>
          </section>
          <section class="panel block">
            <h2>运行任务与异常</h2>
            <div class="list-row" v-for="j in jobs.slice(0, 40)">
              <div>
                <strong>{{ j.type }} · {{ statusNames[j.status] }}</strong
                ><small
                  >{{ j.error?.message || j.id }} · 尝试
                  {{ j.attempts }} 次</small
                >
              </div>
              <button
                v-if="
                  j.type === 'judge' &&
                  ['failed', 'degraded'].includes(j.status)
                "
                class="outline"
                :disabled="busy"
                @click="retryJob(j)"
              >
                重新评估
              </button>
            </div>
            <p v-if="!jobs.length" class="empty">暂无任务。</p>
          </section>
          <details class="panel block">
            <summary>旧版历史记录（只读保留，{{ legacy.length }} 条）</summary>
            <button
              class="outline"
              @click="
                download(JSON.stringify(legacy, null, 2), 'legacy-records.json')
              "
            >
              导出历史备份
            </button>
            <p v-for="r in legacy">{{ r.question }} · {{ r.review_status }}</p>
          </details></template
        >
        <template v-if="page === 'metrics' && expert"
          ><p class="subtle intro">
            仅统计你有权查看的领域。当前统计用于校准裁判和分流规则，不代表模型已完成训练。
          </p>
          <div v-if="metrics" class="metric-grid">
            <section
              v-for="(label, key) in {
                turns: '问答轮数',
                feedback: '收到反馈',
                review_cases: '评审案例',
                pending: '待处理',
                approved: '已审核',
                confirmed_issues: '确认存在问题',
                sampled_reviewed: '已审核抽查样本',
                sampled_issues: '抽查发现问题',
                judge_failures: '裁判失败或降级',
                model_failures: '回答失败',
                tokens: '回答 token 用量',
              }"
              class="panel metric"
            >
              <span>{{ label }}</span
              ><strong>{{ metrics[key] }}</strong>
            </section>
          </div>
          <section v-if="metrics" class="panel block">
            <p>
              裁判与专家原始偏好一致：{{
                metrics.judge_agreement
                  ? `${metrics.judge_agreement.matched} / ${metrics.judge_agreement.total}`
                  : "暂无足够的已审核样本"
              }}
            </p>
            <p>
              平均送审到确认耗时：{{
                metrics.average_review_hours === null
                  ? "暂无数据"
                  : metrics.average_review_hours.toFixed(2) + " 小时"
              }}（包含等待时间）
            </p>
            <p>
              已知成功调用估算费用：{{ metrics.cost.amount.toFixed(6) }} 元；{{
                metrics.cost.unknown
              }}
              次成功调用缺少单价或用量。未计失败、重试及额外供应商收费，以账单为准。存储：{{
                metrics.storage
              }}。
            </p>
            <p class="subtle">
              抽查用于发现漏判；不要只根据已送审的案例推断全部回答准确率。
            </p>
          </section></template
        >
      </div>
    </main>
  </div>
</template>

<style scoped>
.login-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background:
    radial-gradient(ellipse at top left, #e4efde, transparent 60%), #f5f7f5;
  padding: 24px;
}
.login-card {
  background: white;
  border: 1px solid #e0e8e2;
  border-radius: 18px;
  padding: 40px;
  max-width: 470px;
  width: 100%;
  box-shadow: 0 18px 60px #173e3410;
}
.login-card h1 {
  margin: 26px 0 20px;
}
.login-card .primary {
  width: 100%;
  margin-top: 20px;
}
.brand-line {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #216b50;
  font-size: 20px;
}
.brand-line small {
  display: block;
  font-size: 10px;
  letter-spacing: 1.5px;
  margin-top: 5px;
}
.subtle {
  color: #718278;
  font-size: 13px;
  line-height: 1.9;
}
.login-card > .subtle {
  margin-top: 18px;
}
.wb-layout {
  display: flex;
  min-height: 100vh;
}
.wb-sidebar {
  width: 240px;
  flex-shrink: 0;
  background: #fff;
  border-right: 1px solid #e1e8e4;
  position: fixed;
  height: 100vh;
  padding: 30px 20px;
  display: flex;
  flex-direction: column;
  z-index: 10;
}
.workspace-label {
  margin: 32px 0;
  font-weight: 600;
}
.workspace-label small {
  display: block;
  font-weight: 400;
  color: #859187;
  margin-top: 8px;
}
.wb-sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-sidebar nav button {
  padding: 13px 15px;
  justify-content: flex-start;
  border-radius: 8px;
  color: #687b71;
}
.wb-sidebar nav button.active {
  background: #eaf3eb;
  color: #216b50;
  font-weight: 600;
}
.wb-profile {
  margin-top: auto;
  display: grid;
  gap: 8px;
  border-top: 1px solid #e9eeea;
  padding-top: 20px;
}
.wb-profile span {
  font-size: 12px;
  color: #7c8b81;
}
.wb-profile button {
  justify-content: flex-start;
  font-size: 12px;
  margin-top: 8px;
}
.wb-main {
  margin-left: 240px;
  min-width: 0;
  width: calc(100% - 240px);
}
.wb-top {
  height: 70px;
  background: #fff;
  border-bottom: 1px solid #e6ece8;
  padding: 0 38px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #7c8b81;
}
.wb-content {
  padding: 30px 38px;
  max-width: 1600px;
  margin: auto;
}
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}
.heading .eyebrow {
  margin-bottom: 8px;
}
.intro {
  margin-bottom: 24px;
}
.block {
  padding: 25px;
  margin: 20px 0;
}
.block h2 {
  margin-bottom: 15px;
}
.block > p {
  margin: 10px 0;
}
.block > button {
  margin-top: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 15px 0;
  font-size: 13px;
}
input,
select {
  width: 100%;
}
.inline-check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.inline-check input {
  width: 17px;
  height: 17px;
}
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 15px 0;
}
.toolbar select {
  width: auto;
}
.error,
.success-message,
.warning {
  padding: 13px 17px;
  border-radius: 8px;
  margin: 15px 0;
  overflow-wrap: anywhere;
}
.error {
  background: #fff0ec;
  color: #9c4132;
}
.success-message {
  background: #e8f4e8;
  color: #316941;
}
.warning {
  background: #fff6df;
  color: #805c20;
}
.chat-layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 23px;
}
.conversation-list {
  align-self: start;
  padding: 15px;
  position: sticky;
  top: 20px;
  max-height: 75vh;
  overflow: auto;
}
.conversation-list > .primary {
  width: 100%;
  margin-bottom: 15px;
}
.conversation {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  padding: 12px;
  border-radius: 7px;
  gap: 7px;
}
.conversation strong {
  font-weight: 500;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.conversation small {
  color: #809085;
}
.conversation.selected {
  background: #edf4ec;
}
.conversation-body {
  min-width: 0;
}
.welcome {
  text-align: center;
  padding: 55px 30px;
  color: #62806b;
}
.welcome svg {
  margin-bottom: 20px;
}
.welcome p {
  margin-top: 15px;
}
.question-bubble {
  background: #e7efe6;
  border-radius: 12px;
  padding: 18px 22px;
  margin-bottom: 18px;
}
.question-bubble small {
  color: #718278;
}
.question-bubble p {
  white-space: pre-wrap;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
.wb-answers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.candidate {
  padding: 20px;
  min-width: 0;
}
.candidate h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.candidate h3 small {
  font-size: 11px;
  font-weight: 400;
  color: #819085;
  display: block;
  width: 100%;
  margin-top: 5px;
}
.letter {
  background: #eaf2e7;
  padding: 3px 8px;
  border-radius: 5px;
  color: #487d4e;
}
.answer-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.95;
  margin-top: 16px;
  max-height: 520px;
  overflow: auto;
}
.candidate .text-button {
  margin-top: 18px;
}
.feedback-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 16px 0 28px;
  font-size: 12px;
}
.feedback-bar > .choice {
  font-size: 12px;
  background: white;
  border: 1px solid #dbe5db;
  border-radius: 6px;
  padding: 8px 10px;
}
.feedback-bar > .choice.chosen {
  background: #276f4b;
  color: white;
  border-color: #276f4b;
}
.feedback-bar details {
  width: 100%;
  margin-top: 6px;
}
.composer-v3 {
  padding: 20px;
}
.composer-image {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: #f6f9f3;
  border: 1px solid #e4ecd9;
  border-radius: 8px;
  margin: 12px 0;
}
.composer-image img {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #dfe7e3;
  flex-shrink: 0;
}
.composer-image span {
  flex: 1;
  font-size: 12px;
  color: #718260;
  overflow-wrap: anywhere;
}
.image-pick {
  display: inline-flex;
  align-items: center;
}
.image-pick .inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 400;
  font-size: 12px;
  color: #4d7661;
  cursor: pointer;
  margin: 0;
  white-space: nowrap;
}
.image-pick .inline-check input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}
.form-bottom {
  display: flex;
  gap: 20px;
  align-items: center;
  justify-content: space-between;
}
.form-bottom small {
  font-size: 11px;
  line-height: 1.8;
  color: #7f8b81;
  max-width: 75%;
}
.references {
  font-size: 12px;
  padding: 12px 0;
  color: #718278;
}
summary {
  cursor: pointer;
  line-height: 1.8;
}
.list-row {
  display: flex;
  width: 100%;
  padding: 18px 0;
  border-bottom: 1px solid #eef1ed;
  justify-content: space-between;
  text-align: left;
  gap: 20px;
  overflow-wrap: anywhere;
}
.list-row div {
  min-width: 0;
}
.list-row strong {
  display: block;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.7;
}
.list-row small {
  display: block;
  font-size: 12px;
  color: #829085;
  line-height: 1.8;
  margin-top: 7px;
}
.empty {
  text-align: center;
  padding: 40px;
  color: #829085;
}
.tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 14px 0;
}
.approval {
  border-top: 1px solid #e3e9e2;
  margin-top: 22px;
  padding-top: 20px;
}
.document-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 500px;
  overflow: auto;
  font-family: inherit;
  line-height: 1.9;
  font-size: 13px;
  background: #f5f7f3;
  padding: 20px;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.metric {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.metric span {
  color: #758578;
  font-size: 13px;
}
.metric strong {
  font-size: 30px;
  font-weight: 600;
}
.badge {
  white-space: normal;
  flex-shrink: 0;
}
.button-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}
a.text-button {
  display: inline-flex;
  margin: 12px 0;
}
@media (max-width: 1100px) {
  .chat-layout {
    grid-template-columns: 170px minmax(0, 1fr);
  }
  .wb-content {
    padding: 25px;
  }
  .wb-answers {
    grid-template-columns: 1fr;
  }
  .metric-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 760px) {
  .wb-layout {
    display: block;
  }
  .wb-sidebar {
    position: static;
    width: 100%;
    height: auto;
    padding: 16px;
  }
  .wb-sidebar > .brand-line {
    font-size: 18px;
  }
  .workspace-label {
    display: none;
  }
  .wb-sidebar nav {
    flex-direction: row;
    overflow-x: auto;
    margin-top: 18px;
    padding-bottom: 4px;
  }
  .wb-sidebar nav button {
    white-space: nowrap;
    padding: 10px;
    font-size: 12px;
  }
  .wb-profile {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding-top: 12px;
  }
  .wb-profile button {
    margin: 0 0 0 auto;
  }
  .wb-main {
    margin-left: 0;
    width: 100%;
  }
  .wb-top {
    height: 52px;
    padding: 0 18px;
    font-size: 12px;
  }
  .wb-content {
    padding: 22px 16px;
  }
  .chat-layout {
    grid-template-columns: 1fr;
  }
  .conversation-list {
    position: static;
    max-height: 160px;
  }
  .conversation-list .conversation {
    padding: 8px;
  }
  .field-grid {
    grid-template-columns: 1fr;
  }
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .block {
    padding: 18px;
  }
  .login-card {
    padding: 26px;
  }
  .heading h1 {
    font-size: 24px;
  }
  .form-bottom {
    align-items: flex-end;
    gap: 10px;
  }
  .form-bottom .primary {
    white-space: nowrap;
  }
  .list-row {
    gap: 10px;
  }
  .badge {
    font-size: 11px;
  }
  .candidate {
    padding: 17px;
  }
  .metric {
    padding: 17px;
  }
}
</style>
