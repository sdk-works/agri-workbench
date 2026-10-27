<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from "vue";
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
  Building2,
  FolderKanban,
  Menu,
  Mic,
  PhoneOff,
  Volume2,
  Sparkles,
  Camera,
  Radio,
  X,
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
  domains = ["种植管理", "农业物联网", "农业销售", "设计"];
const conversations = ref([]),
  teamConvs = ref([]),
  teamTurns = ref([]),
  teamConv = ref(null),
  teamUsers = ref([]),
  teamFilters = ref({ q: "", dept: "", owner: "", range: "7" }),
  teamPage = ref(1),
  teamTotal = ref(0),
  teamStats = ref({}),
  teamLoading = ref(false),
  teamOpen = ref(""),
  teamRanges = [
    { value: "today", label: "今天" },
    { value: "7", label: "近 7 天" },
    { value: "30", label: "近 30 天" },
    { value: "all", label: "全部" },
  ],
  conversationId = ref(""),
  turns = ref([]),
  question = ref(""),
  deep = ref(false),
  deptFilter = ref("all"),
  empSearch = ref(""),
  empRole = ref(""),
  empStatus = ref(""),
  empPage = ref(1),
  panelOpen = ref(false),
  deptDialog = ref(false),
  deptMenu = ref(""),
  nowTick = ref(Date.now()),
  domain = ref(domains[0]),
  draft = ref(null),
  pendingImage = ref(null),
  comments = ref({}),
  confirmingDelete = ref("");
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
    dept_ids: [],
    scope_all: false,
    active: true,
  }),
  models = ref({}),
  rules = ref({}),
  blockRules = ref([]),
  ruleForm = ref({ name: "", kind: "keyword", pattern: "", action: "block", note: "" }),
  jobs = ref([]),
  metrics = ref(null),
  legacy = ref([]);
const imageNotice = ref(""),
  imageTasks = ref([]),
  imageForm = ref({ prompt: "", size: 1024 }),
  imageSubmitting = ref(false);
const departments = ref([]),
  currentDept = ref(null),
  deptEntries = ref([]),
  deptForm = ref({ name: "" }),
  editingDept = ref(null),
  entryForm = ref({});
// 问题领域选项 = active 部门名（与后端 availableDomains 同步，新增部门自动出现）。
const domainOptions = computed(() =>
  departments.value.filter((d) => d.active !== false).map((d) => d.name)
);
// 移动端侧边栏抽屉开关。
const menuOpen = ref(false);

// ── 语音通话 ─────────────────────────────────────────
// 安卓壳通过 window.QingHeVoice 暴露原生识别/朗读；桌面浏览器回退 Web Speech API。
const voiceMode = ref(false);
const voiceState = ref("idle"); // idle | listening | thinking | speaking
const voiceText = ref("");
const voiceError = ref("");
let voiceRec = null;
let voiceAwaiting = false;
let voiceSpokenTurn = "";

const voiceNative = () =>
  typeof window !== "undefined" && window.QingHeVoice ? window.QingHeVoice : null;
const voiceSupported = computed(() => {
  if (typeof window === "undefined") return false;
  const n = voiceNative();
  if (n && typeof n.available === "function") {
    try {
      if (n.available() === "1") return true;
    } catch (e) {}
  }
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
});
const voiceStateText = computed(
  () =>
    ({
      idle: voiceHandsFree.value ? "直接说话" : "按住说话",
      listening: voiceHandsFree.value ? "我在听…" : "正在录音…",
      recognizing: "正在识别…",
      thinking: "正在思考…",
      speaking: "正在播报…",
    })[voiceState.value] || ""
);
const imageStatus = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const expert = computed(() => ["expert", "admin"].includes(user.value?.role)),
  admin = computed(() => user.value?.role === "admin");
// 部门管理员：只能看/管自己部门的人
const manager = computed(
  () => user.value?.role === "manager" || user.value?.scope_all === true
);
const canManageUsers = computed(() => admin.value || manager.value);
const manageableDepartments = computed(() =>
  admin.value
    ? departments.value
    : departments.value.filter((d) =>
        (user.value?.dept_ids || []).includes(d.id)
      )
);
const teamOwnerName = computed(() => {
  const id = teamFilters.value.owner;
  return teamUsers.value.find((u) => u.id === id)?.name || "全部成员";
});
const teamRangeLabel = computed(
  () =>
    teamRanges.value.find((r) => r.value === teamFilters.value.range)?.label ||
    "近 7 天"
);
const teamDepartments = computed(() =>
  admin.value || user.value?.scope_all
    ? departments.value
    : departments.value.filter((d) =>
        (user.value?.dept_ids || []).includes(d.id)
      )
);
const activeDepts = computed(() =>
  departments.value.filter((d) => d.active !== false)
);
const inactiveDepts = computed(() =>
  departments.value.filter((d) => d.active === false)
);
const unassignedCount = computed(
  () => users.value.filter((u) => !(u.dept_ids || []).length).length
);
function deptCount(id) {
  return users.value.filter((u) => (u.dept_ids || []).includes(id)).length;
}
const filteredEmployees = computed(() => {
  const q = empSearch.value.trim().toLowerCase();
  return users.value
    .filter((u) => {
      if (deptFilter.value === "none") {
        if ((u.dept_ids || []).length) return false;
      } else if (deptFilter.value !== "all") {
        if (!(u.dept_ids || []).includes(deptFilter.value)) return false;
      }
      if (empRole.value && u.role !== empRole.value) return false;
      if (empStatus.value === "active" && !u.active) return false;
      if (empStatus.value === "inactive" && u.active) return false;
      if (q) {
        const hay = `${u.name || ""} ${u.username || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) =>
      String(a.name || a.username).localeCompare(String(b.name || b.username), "zh-CN")
    );
});
const empPageCount = computed(() =>
  Math.max(1, Math.ceil(filteredEmployees.value.length / 20))
);
const pagedEmployees = computed(() =>
  filteredEmployees.value.slice((empPage.value - 1) * 20, empPage.value * 20)
);
const accountDeptOptions = computed(() =>
  manageableDepartments.value.filter(
    (d) => d.active !== false && !(account.value.dept_ids || []).includes(d.id)
  )
);
const assignableRoles = computed(() =>  admin.value
    ? roleNames
    : { employee: roleNames.employee, expert: roleNames.expert }
);
// 员工的问题领域跟随所属部门，不再手动选
const myDepts = computed(() =>
  departments.value.filter(
    (d) => d.active !== false && (user.value?.dept_ids || []).includes(d.id)
  )
);
const autoDomain = computed(() => myDepts.value[0]?.name || "");
// 非管理员只能看到自己部门的领域；管理员为全部
const allowedDomainOptions = computed(() =>
  admin.value
    ? domainOptions.value
    : domainOptions.value.filter((n) =>
        myDepts.value.some((d) => d.name === n)
      )
);
const singleDomain = computed(() =>
  allowedDomainOptions.value.length === 1 ? allowedDomainOptions.value[0] : ""
);
const annotationStatus = computed(() => {
  const a = annotation.value?.annotation;
  if (!a) return { class: "neutral", text: "未标注" };
  if (a.status === "approved")
    return { class: "success", text: `已确认 v${a.revision}` };
  return { class: "amber", text: `草稿 v${a.revision}` };
});
const roleNames = {
  employee: "普通员工",
  expert: "领域专家",
  manager: "部门管理员",
  admin: "管理员",
};
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
  canceled: "已取消",
  interrupted: "已中断",
  degraded: "本地降级",
  unavailable: "无法比较",
  parsing: "解析中",
  pending: "待审核",
  published: "已发布",
  rejected: "已退回",
  blocked: "被拦截",
};
function docStatusClass(s) {
  return {
    published: "success",
    pending: "amber",
    rejected: "danger",
    blocked: "danger",
    parsing: "neutral",
  }[s] || "neutral";
}
const choices = {
  A: "采用 A",
  B: "采用 B",
  tie: "都可以",
  both_bad: "都不好",
  insufficient: "信息不足",
};
const nav = computed(() => {
  return [
    { id: "chat", label: "农业问答", icon: MessageSquare },
    ...(canManageUsers.value
      ? [{ id: "team", label: "团队提问", icon: Users }]
      : []),
    { id: "images", label: "生成图片", icon: ImagePlus },
    { id: "documents", label: "知识资料", icon: Library },
    ...(expert.value
      ? [
          { id: "reviews", label: "专家评审", icon: ShieldCheck },
          { id: "metrics", label: "质量看板", icon: LayoutDashboard },
        ]
      : []),
    ...(canManageUsers.value
      ? [{ id: "users", label: "组织与权限", icon: Users }]
      : []),
    ...(admin.value
      ? [{ id: "settings", label: "模型与规则", icon: Settings }]
      : []),
  ];
});
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
  clock,
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
    await loadDepartments();
    await refresh();
  });
}
async function loadDepartments() {
  departments.value = (await call("/departments")).items;
  // 管理员在部门停用/变动时回退到第一个；其他人由所属部门推导，不默认归属
  if (
    admin.value &&
    domainOptions.value.length &&
    !domainOptions.value.includes(domain.value)
  )
    domain.value = domainOptions.value[0];
  if (
    admin.value &&
    domainOptions.value.length &&
    !domainOptions.value.includes(upload.value.domain)
  )
    upload.value.domain = domainOptions.value[0];
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
  menuOpen.value = false;
  error.value = "";
  notice.value = "";
  detail.value = null;
  doc.value = null;
  await act(refresh);
  if (id === "team") {
    try {
      await Promise.all([loadTeamUsers(), loadTeam()]);
    } catch (e) {
      error.value = e.message;
    }
  }
}

function elapsedSeconds(t) {
  const start = new Date(t.created_at || 0).getTime();
  if (!start) return 0;
  const s = Math.floor((nowTick.value - start) / 1000);
  return s > 0 ? s : 0;
}

function formatTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    return String(v).slice(0, 16).replace("T", " ");
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(v) {
  const d = new Date(v || 0);
  if (Number.isNaN(d.getTime())) return "";
  const diff = (Date.now() - d.getTime()) / 60000;
  if (diff < 1) return "刚刚";
  if (diff < 60) return Math.floor(diff) + " 分钟前";
  if (diff < 1440) return Math.floor(diff / 60) + " 小时前";
  return Math.floor(diff / 1440) + " 天前";
}

function teamRangeFrom() {
  const r = teamFilters.value.range;
  if (r === "all") return "";
  const d = new Date();
  d.setDate(d.getDate() - (r === "today" ? 0 : Number(r)));
  return d.toISOString().slice(0, 10);
}

function toggleTeamFilter(key) {
  teamOpen.value = teamOpen.value === key ? "" : key;
}

function pickTeamFilter(key, value) {
  teamFilters.value[key] = value;
  teamOpen.value = "";
  loadTeam();
}

async function loadTeamUsers() {
  try {
    const r = await call("/users");
    teamUsers.value = r.items || [];
  } catch (e) {
    teamUsers.value = [];
  }
}

async function loadTeam(reset = true) {
  if (reset) teamPage.value = 1;
  teamLoading.value = true;
  try {
    const f = teamFilters.value;
    const params = new URLSearchParams({
      scope: "team",
      page: String(teamPage.value),
      pageSize: "20",
    });
    if (f.q.trim()) params.set("q", f.q.trim());
    if (f.dept) params.set("dept", f.dept);
    if (f.owner) params.set("owner", f.owner);
    const from = teamRangeFrom();
    if (from) params.set("from", from);
    const r = await call("/conversations?" + params.toString());
    teamConvs.value = r.items || [];
    teamTotal.value = r.total || 0;
    teamStats.value = r.stats || {};
    if (
      teamConv.value &&
      !teamConvs.value.some((c) => c.id === teamConv.value.id)
    ) {
      teamConv.value = null;
      teamTurns.value = [];
    }
  } finally {
    teamLoading.value = false;
  }
}

async function openTeamConv(c) {
  teamConv.value = c;
  const r = await call("/turns?scope=team&conversation_id=" + c.id);
  teamTurns.value = r.items || [];
}
async function refreshCurrent() {
  await refresh();
  if (page.value === "team") await loadTeam();
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
      // 拉取含配图轮次的图片任务状态（在问答里直接显示配图卡片）
      for (const t of turns.value) {
        if (!t.gen_image) continue;
        // 已完成/失败/取消的配图不再重复拉取，避免每次轮询重建 <img> 导致闪屏
        if (t.imageTask && ["completed", "failed", "cancelled"].includes(t.imageTask.status))
          continue;
        try {
          t.imageTask = (await call("/images/tasks/" + t.gen_image)).task;
        } catch {
          t.imageTask = { status: "failed", error: "图片状态获取失败" };
        }
        if (!current()) break;
      }
    }
  }
  if (view === "reviews") {
    const response = await call("/reviews");
    if (current()) reviews.value = response.items;
  }
  if (view === "images") {
    const response = await call("/images/tasks");
    if (current()) imageTasks.value = response.items;
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
  if (view === "departments") {
    const response = await call("/departments");
    if (current()) departments.value = response.items;
  }
  if (view.startsWith("dept:")) {
    const deptId = view.slice(5);
    const response = await call("/entries?dept=" + deptId);
    if (current()) {
      currentDept.value = response.dept;
      deptEntries.value = response.items;
    }
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
    if (["chat", "images", "reviews", "documents"].includes(page.value))
      await refresh();
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
async function deleteConversation(c) {
  // 二次确认：第一次点击进入确认态（按钮变"确认删除？"），4 秒内再点执行
  if (confirmingDelete.value !== c.id) {
    confirmingDelete.value = c.id;
    setTimeout(() => {
      if (confirmingDelete.value === c.id) confirmingDelete.value = "";
    }, 4000);
    return;
  }
  confirmingDelete.value = "";
  if (busy.value) return;
  busy.value = true;
  try {
    await call(`/conversations/${c.id}`, undefined, "DELETE");
    if (conversationId.value === c.id) {
      conversationId.value = "";
      turns.value = [];
      domain.value = "";
    }
    notice.value = "会话已删除";
    await act(refresh);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function submitImage() {
  if (imageSubmitting.value) return;
  const prompt = imageForm.value.prompt.trim();
  if (!prompt) {
    error.value = "请输入提示词";
    return;
  }
  error.value = "";
  notice.value = "";
  imageSubmitting.value = true;
  try {
    await call("/images/generate", {
      prompt,
      size: Number(imageForm.value.size),
    });
    imageForm.value.prompt = "";
    await refresh();
    notice.value = "已提交出图任务，可在下方查看进度";
  } catch (e) {
    error.value = e.message;
  } finally {
    imageSubmitting.value = false;
  }
}
async function cancelImage(id) {
  imageNotice.value = "";
  await act(async () => {
    const r = await call("/images/tasks/" + id + "/cancel", {});
    // 服务端不会"假取消"：已完成/无法中断时 cancelled=false，这里照实告诉用户
    if (r && r.cancelled === false) {
      imageNotice.value =
        r.reason === "already_finished"
          ? "该任务已经结束，无需取消"
          : "取消失败：" + (r.error || "服务端未确认取消，任务可能仍在生成");
    } else {
      imageNotice.value = "已取消该任务";
    }
    await refresh();
  });
}
function imageUrl(id) {
  return "/api/v2/images/" + id + "/file";
}
function imageTitle(t) {
  const size = t.width + "×" + t.height;
  const at = t.completed_at ? " · " + new Date(t.completed_at).toLocaleString() : "";
  return `${t.prompt}（${size}${at}）`;
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
  if (!allowedDomainOptions.value.length) {
    notice.value = "还没有分配部门，请联系管理员分配后再提问。";
    return;
  }
  await act(async () => {
    if (
      !draft.value ||
      draft.value.question !== question.value ||
      draft.value.conversation_id !== conversationId.value ||
      Boolean(draft.value.deep) !== Boolean(deep.value) ||
      Boolean(draft.value.image) !== Boolean(pendingImage.value)
    )
      draft.value = {
        request_id: crypto.randomUUID(),
        question: question.value,
        domain: domain.value,
        deep: deep.value,
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
function onComposerKeydown(e) {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (busy.value) return;
  if (!question.value.trim()) return;
  if (turns.value.some((t) => t.status === "generating")) return;
  ask();
}
function onComposerPaste(e) {
  const items = e.clipboardData || window.clipboardData;
  if (!items) return;
  let file = null;
  for (const it of items.items || []) {
    if (it.type && it.type.indexOf("image/") === 0) {
      file = it.getAsFile();
      break;
    }
  }
  if (!file) return;
  e.preventDefault();
  const input = e.currentTarget
    ?.closest(".composer-v3")
    ?.querySelector(".image-pick input[type=file]");
  if (input) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
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
async function adopt(t, choice) {
  await act(async () => {
    await call(`/turns/${t.id}/adopt`, { choice });
    notice.value = "已采用，已停止另一条回答。";
    await refresh();
  });
}
async function cancelTurn(t) {
  await act(async () => {
    await call(`/turns/${t.id}/cancel`, {});
    notice.value = "已停止。";
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
  if (!allowedDomainOptions.value.length) {
    notice.value = "还没有分配部门，请联系管理员分配后再上传资料。";
    return;
  }
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
    notice.value =
      action === "publish"
        ? `已发布新版本 v${doc.value.revision}，该资料已参与问答检索。`
        : "资料已退回。";
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
function openNewUser() {
  resetUser();
  panelOpen.value = true;
}
function openEditUser(u) {
  editUser(u);
  panelOpen.value = true;
}
function closeUserPanel() {
  panelOpen.value = false;
  resetUser();
}
function resetEmpFilters() {
  empSearch.value = "";
  empRole.value = "";
  empStatus.value = "";
  deptFilter.value = "all";
  empPage.value = 1;
}
function addAccountDept(id) {
  if (!id) return;
  if (!account.value.dept_ids.includes(id))
    account.value.dept_ids = [...account.value.dept_ids, id];
}
function removeAccountDept(id) {
  account.value.dept_ids = account.value.dept_ids.filter((x) => x !== id);
}
function openNewDept() {
  editingDept.value = null;
  deptForm.value = { name: "" };
  deptDialog.value = true;
}
function openEditDept(d) {
  editDept(d);
  deptMenu.value = "";
  deptDialog.value = true;
}
function editUser(u) {
  account.value = {
    ...u,
    domains: [...(u.domains || [])],
    dept_ids: [...(u.dept_ids || [])],
    password: "",
  };
}
function resetUser() {
  account.value = {
    username: "",
    name: "",
    password: "",
    role: "employee",
    dept_ids: [],
    scope_all: false,
    active: true,
  };
}
async function saveUser() {
  await act(async () => {
    if (account.value.role === "manager" && !(account.value.dept_ids || []).length)
      throw Error("部门管理员至少选择一个所属部门");
    await call("/users", account.value);
    panelOpen.value = false;
    resetUser();
    await refresh();
    notice.value = "员工账号已保存。";
  });
}
function deptNames(u) {
  const ids = Array.isArray(u?.dept_ids) ? u.dept_ids : [];
  return (
    ids
      .map((id) => departments.value.find((d) => d.id === id)?.name)
      .filter(Boolean)
      .join("、") || "未分配部门"
  );
}
function deptName(id) {
  return departments.value.find((d) => d.id === id)?.name || id;
}
function manualCheckUpdate() {
  const n = voiceNative();
  if (n && typeof n.checkUpdate === "function") {
    notice.value = "正在检查更新…";
    try {
      n.checkUpdate();
    } catch (e) {
      notice.value = "检查更新失败";
    }
  } else {
    notice.value = "请在「京阳智农」安卓应用内检查更新";
  }
}
function roleBadge(role) {  return role === "admin"
    ? "danger"
    : role === "manager"
      ? "amber"
      : role === "expert"
        ? "cloud"
        : "neutral";
}
function permissionText(u) {
  if (u.role === "admin") return "账号、部门、模型规则";
  if (u.scope_all) return "全部部门（含新增）· 管理员工";
  if (u.role === "manager") return "管理本部门员工";
  if (u.role === "expert") return "问答、评审、资料";
  return "问答与资料";
}
function resetDeptForm() {
  editingDept.value = null;
  deptForm.value = { name: "" };
}
function editDept(d) {
  editingDept.value = d;
  deptForm.value = { name: d.name };
}
async function saveDept() {
  await act(async () => {
    if (!deptForm.value.name.trim()) throw Error("请填写部门名称");
    if (editingDept.value)
      await call("/departments", { id: editingDept.value.id, name: deptForm.value.name }, "PUT");
    else await call("/departments", { name: deptForm.value.name });
    notice.value = editingDept.value ? "部门已更新。" : "部门已新增。";
    deptDialog.value = false;
    resetDeptForm();
    await refresh();
  });
}
async function toggleDept(d) {
  await act(async () => {
    await call("/departments", { id: d.id, active: !(d.active !== false) }, "PUT");
    notice.value = d.active !== false ? "部门已停用。" : "部门已启用。";
    await refresh();
  });
}
async function deleteDept(d) {
  await act(async () => {
    await call("/departments", { id: d.id }, "DELETE");
    notice.value = "部门已删除。";
    await refresh();
  });
}
function openDept(d) {
  entryForm.value = {
    dept_id: d.id,
    name: "",
    code: "",
    status: "",
    owner: "",
    note: "",
  };
}
function resetEntry() {
  entryForm.value = {};
}
function editEntry(e) {
  entryForm.value = { ...e };
}
async function saveEntry() {
  await act(async () => {
    const body = { ...entryForm.value };
    if (!body.dept_id) throw Error("请选择部门");
    if (body.id) await call("/entries", body, "PUT");
    else await call("/entries", body);
    resetEntry();
    await refresh();
    notice.value = "条目已保存。";
  });
}
async function deleteEntry(e) {
  await act(async () => {
    await call("/entries", { id: e.id }, "DELETE");
    resetEntry();
    await refresh();
    notice.value = "条目已删除。";
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
// ── 语音通话 v2：服务端语音 + 流式回答 ─────────────────
const voiceSetupOpen = ref(false);
const voiceSetupSteps = ref([]);
const voiceAnswerText = ref("");
const voiceLevel = ref(0);
let voiceHistory = [];
let voiceConversationId = "";
let voiceQueue = [];
let voiceSpeaking = false;
let voiceStreamDone = true;
let voiceCapture = null;
let voiceAudio = null;
let voiceSpeakResolve = null;
let voiceServer = { ok: false, asr: false, tts: false };
// 打断与状态机：同一 request_id 贯穿 识别→生成→播报，卡在哪一步可以定位
let voiceAbort = null;
let voiceTurnId = "";
let voiceRequestId = "";
let voiceInterrupted = false;
// 轮次编号：每次录音/识别自增，迟到的旧识别与旧答案一律作废
let voiceEpoch = 0;
let voiceAsrAbort = null;
const voicePhase = ref(""); // queued | generating | completed | failed | canceled

// ── 按住说话（PTT）：录音结束由用户动作决定，不依赖停顿检测 ──
const VOICE_MAX_MS = 60000; // 单次上限：到点自动结束并提交
const VOICE_MIN_MS = 300; // 过短视为误触，不提交
const VOICE_WARN_MS = 50000; // 提前 10s 提示
const VOICE_CANCEL_PX = 60; // 上滑取消阈值
const voiceHolding = ref(false);
const voiceHoldMs = ref(0);
const voiceCancelArmed = ref(false);
const voiceRequesting = ref(false);
let voiceHoldStart = 0;
let voiceHoldY = 0;
let voiceHoldSubmitted = false;
let voiceHoldAbort = false;
let voiceWarned = false;
let voiceNativeCaps = { rec: false, asr: false };

// ── 免按键收听：说完停顿即发送，回答结束自动接着听 ──
const VOICE_HF_KEY = "voice.handsfree";
const VOICE_SILENCE_MS = 900; // 连续静音多久判定说完
const VOICE_MIN_VOICE_MS = 420; // 有效发声下限，防环境噪音被当成一句话
const VOICE_HF_DELAY_MS = 260; // 播报结束后稍等再开麦，避免尾音被录入
const voiceHandsFree = ref(false);
const voicePaused = ref(false);
let voiceSilenceSince = 0;
let voiceVoicedMs = 0;
let voiceHfRestart = 0;
try {
  voiceHandsFree.value = localStorage.getItem(VOICE_HF_KEY) === "1";
} catch (e) {}

// ── 拍照与随问附图：先上传拿 image_id，再随语音轮提交 ──
const VOICE_IMAGE_MAX = 8 * 1024 * 1024;
const VOICE_UPLOAD_MS = 45000;
const voiceCamOpen = ref(false);
const voiceCamReady = ref(false);
const voiceCamVideo = ref(null);
const voiceCamError = ref("");
const voiceSheetOpen = ref(false);
const voiceAttach = ref(null); // { id, url, status, error }
let voiceCamStream = null;
let voiceImageSeq = 0;

function showVoiceSetup(steps) {
  voiceSetupSteps.value = steps;
  voiceSetupOpen.value = true;
  voiceState.value = "idle";
}

function startCall() {
  voiceMode.value = true;
  voiceError.value = "";
  voiceText.value = "";
  voiceAnswerText.value = "";
  voiceSetupOpen.value = false;
  voiceHistory = [];
  voiceConversationId = "";
  voiceQueue = [];
  voiceSpeaking = false;
  voiceStreamDone = true;
  document.addEventListener("visibilitychange", onVoiceVisibility);
  window.addEventListener("blur", onVoiceBlur);
  probeAndStart();
}

async function probeAndStart() {
  const n = voiceNative();
  let diag = null;
  if (n && typeof n.diagnose === "function") {
    try {
      diag = JSON.parse(n.diagnose());
    } catch (e) {}
  }
  try {
    const r = await fetch("/api/v2/voice/status", {
      headers: { "X-Workbench": "1" },
    });
    voiceServer = r.ok ? await r.json() : { ok: false, asr: false, tts: false };
  } catch (e) {
    voiceServer = { ok: false, asr: false, tts: false };
  }

  const nativeAsr = Boolean(diag && diag.asr);
  const nativeRec = Boolean(diag && diag.rec);
  voiceNativeCaps = { rec: nativeRec, asr: nativeAsr };
  const mic = diag ? diag.mic : "unknown";

  if (nativeAsr && mic === "denied") {
    if (n.requestMic) {
      try {
        n.requestMic();
      } catch (e) {}
    }
    showVoiceSetup([
      "语音通话需要麦克风权限。",
      "点「授权麦克风」，在系统弹窗里选择「允许」。",
      "若之前拒绝过：点「打开应用设置」→ 权限 → 麦克风 → 允许。",
    ]);
    return;
  }
  // 按住说话：进入待按住状态，绝不自动开始录音
  if (nativeRec || nativeAsr || voiceServer.asr) {
    voiceState.value = "idle";
    return;
  }

  showVoiceSetup([
    "这台设备没有可用的语音识别服务。",
    voiceServer.ok
      ? "服务器语音模型正在加载，请稍等十几秒再试。"
      : "服务器语音服务未启动，请联系管理员。",
    "仍可用文字输入提问，或安装最新安卓应用。",
  ]);
}

function startNativeRec() {
  voiceState.value = "listening";
  voiceText.value = "";
  voiceError.value = "";
  const n = voiceNative();
  try {
    n.recStart();
  } catch (e) {
    voiceError.value = "无法启动录音：" + e;
    voiceState.value = "idle";
  }
}

async function uploadAudio(blob, ext) {
  const epoch = ++voiceEpoch; // 本轮识别
  voiceState.value = "recognizing";
  voicePhase.value = "";
  voiceRequestId = newVoiceRequestId();
  const asrAbort = new AbortController();
  voiceAsrAbort = asrAbort;
  try {
    const r = await fetch("/api/v2/voice/asr?ext=" + ext, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Workbench": "1" },
      body: blob,
      signal: asrAbort.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "识别失败");
    // 用户已经按住新一轮：这条识别结果作废，不能替用户提问
    if (epoch !== voiceEpoch) return;
    const text = String(j.text || "").trim();
    if (!text) {
      voiceError.value = voiceHandsFree.value
        ? "没听到说话，请直接说"
        : "没有听清，请再说一次";
      resumeListening();
      return;
    }
    voiceText.value = text;
    await askStreaming(text, epoch);
  } catch (e) {
    if (epoch !== voiceEpoch) return;
    voiceError.value = e.message || "识别失败";
    voiceState.value = "idle";
  } finally {
    if (voiceAsrAbort === asrAbort) voiceAsrAbort = null;
  }
}

function base64ToBlob(b64, ext) {
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: ext === "m4a" ? "audio/mp4" : "audio/webm" });
}

function startNativeListening() {
  voiceState.value = "listening";
  voiceText.value = "";
  voiceError.value = "";
  const n = voiceNative();
  try {
    n.startListening();
  } catch (e) {
    voiceError.value = "无法启动麦克风";
    voiceState.value = "idle";
  }
}

// ── 按住说话：开始录音（麦克风授权期间松手不算一次录音） ──
async function beginRecording() {
  voiceState.value = "listening";
  voiceText.value = "";
  voiceError.value = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // 授权弹窗期间用户已经松手/取消 → 不当成一次录音，直接释放麦克风
    // 免按键模式不依赖按住，只有主动取消/退出语音通话才作废
    if ((!voiceHolding.value && !voiceHandsFree.value) || voiceHoldAbort || !voiceMode.value) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      voiceState.value = "idle";
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      // 老内核/受限 WebView 没有 WebAudio，录了也没法算音量，直接说清楚
      voiceError.value = "无音频上下文，这台设备录不了音";
      voiceState.value = "idle";
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      return;
    }
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const chunks = [];
    const mime =
      window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      rec = new MediaRecorder(stream);
    }
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.start();
    const cap = { stream, ctx, rec, chunks, raf: 0, stopped: false };
    voiceCapture = cap;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (!voiceMode.value || cap.stopped) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      voiceLevel.value = Math.min(1, rms * 14);
      // 免按键：靠停顿时长判定说完（按住说话时不启用，避免误发半句）
      if (voiceHandsFree.value && !voiceHolding.value) {
        const now = performance.now();
        if (rms > 0.02) {
          voiceVoicedMs += 16;
          voiceSilenceSince = 0;
        } else {
          if (!voiceSilenceSince) voiceSilenceSince = now;
          if (
            voiceVoicedMs >= VOICE_MIN_VOICE_MS &&
            now - voiceSilenceSince >= VOICE_SILENCE_MS
          ) {
            finishCapture();
            return;
          }
        }
      }
      if (voiceHolding.value) {
        const held = performance.now() - voiceHoldStart;
        voiceHoldMs.value = held;
        if (!voiceWarned && held >= VOICE_WARN_MS) {
          voiceWarned = true;
          voiceError.value = "还有 10 秒到达单次上限，将自动发送";
        }
        if (held >= VOICE_MAX_MS) {
          // 上限：自动结束并提交（不依赖静音检测）
          holdVoiceEnd("max");
          return;
        }
      }
      cap.raf = requestAnimationFrame(tick);
    };
    cap.raf = requestAnimationFrame(tick);
  } catch (e) {
    const why =
      e && e.name === "NotAllowedError"
        ? "麦克风权限被拒绝"
        : e.message || "无法打开麦克风";
    // 免按键是自动开麦：失败必须说清楚，否则用户以为在听、其实没开
    voiceError.value = voiceHandsFree.value ? "自动收听启动失败：" + why : why;
    voiceState.value = "idle";
    if (voiceHandsFree.value) voicePaused.value = true;
    showVoiceSetup([
      "浏览器没有拿到麦克风权限。",
      "安卓应用内：设置 → 应用 → 京阳智农 → 权限 → 麦克风 → 允许。",
      "电脑浏览器：点地址栏左侧的锁图标 → 麦克风 → 允许。",
    ]);
  }
}

// 指针捕获 + window 兜底：手指/鼠标移出按钮后松开也必须结束，不能只在按钮上监听
function bindHoldPointer() {
  try {
    window.addEventListener("pointerup", holdVoiceEnd, true);
    window.addEventListener("pointercancel", holdVoiceCancel, true);
    window.addEventListener("pointermove", holdVoiceMove, true);
  } catch (e) {}
}
function unbindHoldPointer() {
  try {
    window.removeEventListener("pointerup", holdVoiceEnd, true);
    window.removeEventListener("pointercancel", holdVoiceCancel, true);
    window.removeEventListener("pointermove", holdVoiceMove, true);
  } catch (e) {}
}

// 按下
function holdVoiceStart(ev) {
  if (!voiceMode.value) return;
  // 免按键模式：点一下开始/暂停，不需要按住
  if (voiceHandsFree.value) {
    toggleListen();
    return;
  }
  if (voiceHolding.value) return;
  // 再按一次 = 打断：立即停播、清待播、取消上一轮生成，然后开始新录音
  if (voiceState.value === "thinking" || voiceState.value === "speaking") interruptVoice();
  voiceInterrupted = false; // 新一轮开始：旧轮次的隔离由 voiceEpoch 负责
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!voiceNativeCaps.rec && !voiceNativeCaps.asr) {
      voiceError.value = "当前页面环境不支持录音";
      showVoiceSetup([
        "浏览器在 http:// 页面下禁止调用麦克风，所以不会弹授权框。",
        "请使用「京阳智农」安卓应用进行语音通话（应用内可直接录音）。",
        "电脑上请用 localhost 访问，或让管理员配置 HTTPS 域名。",
      ]);
      return;
    }
  }
  voiceHolding.value = true;
  try {
    if (ev && ev.currentTarget && ev.currentTarget.setPointerCapture && ev.pointerId != null)
      ev.currentTarget.setPointerCapture(ev.pointerId);
  } catch (e) {}
  bindHoldPointer();
  voiceHoldAbort = false;
  voiceHoldSubmitted = false;
  voiceWarned = false;
  voiceCancelArmed.value = false;
  voiceHoldStart = performance.now();
  voiceHoldMs.value = 0;
  voiceHoldY = ev && typeof ev.clientY === "number" ? ev.clientY : 0;
  voiceError.value = "";

  const n = voiceNative();
  if (voiceNativeCaps.rec && n && n.recStart) {
    try {
      n.recStart();
      voiceState.value = "listening";
      return;
    } catch (e) {}
  }
  if (voiceNativeCaps.asr && n && n.startListening) {
    try {
      n.startListening();
      voiceState.value = "listening";
      return;
    } catch (e) {}
  }
  // Web：先请求麦克风（voiceRequesting.value 用于提示"正在请求"）
  voiceRequesting.value = true;
  beginRecording().finally(() => {
    voiceRequesting.value = false;
  });
}

// 移动：上滑取消
function holdVoiceMove(ev) {
  if (!voiceHolding.value) return;
  const y = ev && typeof ev.clientY === "number" ? ev.clientY : voiceHoldY;
  const up = voiceHoldY - y;
  voiceCancelArmed.value = up >= VOICE_CANCEL_PX;
}

// 松手：发送（或取消/过短）
function holdVoiceEnd(reason) {
  unbindHoldPointer();
  if (!voiceHolding.value) return;
  const held = performance.now() - voiceHoldStart;
  const cancel = voiceCancelArmed.value && reason !== "max";
  voiceHolding.value = false;
  voiceHoldMs.value = 0;
  voiceCancelArmed.value = false;

  const n = voiceNative();
  const nativeOn = voiceNativeCaps.rec || voiceNativeCaps.asr;

  if (cancel) {
    voiceHoldAbort = true;
    try {
      if (voiceNativeCaps.rec && n && n.recCancel) n.recCancel();
      else if (voiceNativeCaps.asr && n && n.stopListening) n.stopListening();
    } catch (e) {}
    cleanupCapture();
    voiceState.value = "idle";
    voiceError.value = "已取消，未发送";
    return;
  }
  if (held < VOICE_MIN_MS && reason !== "max") {
    voiceHoldAbort = true;
    try {
      if (voiceNativeCaps.rec && n && n.recCancel) n.recCancel();
      else if (voiceNativeCaps.asr && n && n.stopListening) n.stopListening();
    } catch (e) {}
    cleanupCapture();
    voiceState.value = "idle";
    voiceError.value = "说话时间太短，请按住多说一会儿";
    return;
  }
  if (voiceHoldSubmitted) return; // 同一次按压只提交一次
  voiceHoldSubmitted = true;

  if (voiceNativeCaps.rec && n && n.recStop) {
    try {
      n.recStop(); // 原生录音结束 → 触发 audio 事件 → 上传识别
      voiceState.value = "recognizing";
      return;
    } catch (e) {}
  }
  if (voiceNativeCaps.asr && n && n.stopListening) {
    try {
      n.stopListening(); // 原生识别结束 → result 事件 → 提交
      return;
    } catch (e) {}
  }
  finishCapture(); // Web：停录 → 上传识别
}

// 意外中断（切后台/来电/pointercancel）：结束并丢弃，不提交
function holdVoiceCancel() {
  unbindHoldPointer();
  if (!voiceHolding.value) return;
  const n = voiceNative();
  voiceHolding.value = false;
  voiceHoldAbort = true;
  voiceHoldMs.value = 0;
  voiceCancelArmed.value = false;
  try {
    if (voiceNativeCaps.rec && n && n.recCancel) n.recCancel();
    else if (voiceNativeCaps.asr && n && n.stopListening) n.stopListening();
  } catch (e) {}
  cleanupCapture();
  voiceState.value = "idle";
  voiceError.value = "录音已中断，未发送";
}

// 停录并提交（Web 路径）
function finishCapture() {
  const cap = voiceCapture;
  if (!cap || cap.stopped) return;
  cap.stopped = true;
  try {
    cancelAnimationFrame(cap.raf);
  } catch (e) {}
  const done = async () => {
    const blob = new Blob(cap.chunks, { type: "audio/webm" });
    cleanupCapture();
    if (voiceHoldAbort) {
      voiceState.value = "idle";
      return;
    }
    if (blob.size < 2500) {
      voiceState.value = "idle";
      voiceError.value = "没有录到声音，请按住再说一次";
      return;
    }
    await uploadAudio(blob, "webm");
  };
  try {
    cap.rec.onstop = done;
    cap.rec.stop();
  } catch (e) {
    done();
  }
}

function onVoiceBlur() {
  onVoiceVisibility("blur");
}

// 页面不可见 / 失焦：按中断处理，绝不发半段
function onVoiceVisibility(kind) {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  if ((kind === "blur" || hidden) && voiceHolding.value) holdVoiceCancel();
}

function cleanupCapture() {
  const cap = voiceCapture;
  voiceCapture = null;
  voiceLevel.value = 0;
  if (!cap) return;
  try {
    cancelAnimationFrame(cap.raf);
  } catch (e) {}
  try {
    cap.stream.getTracks().forEach((t) => t.stop());
  } catch (e) {}
  try {
    cap.ctx.close();
  } catch (e) {}
}

/* ── 免按键收听：说完自动发送，回答完自动接着听 ──────────── */

function startHandsFree() {
  if (!voiceMode.value) return;
  voicePaused.value = false;
  voiceHolding.value = false;
  voiceCancelArmed.value = false;
  voiceSilenceSince = 0;
  voiceVoicedMs = 0;
  voiceRequesting.value = true;
  beginRecording().finally(() => {
    voiceRequesting.value = false;
  });
}

function toggleHandsFree() {
  voiceHandsFree.value = !voiceHandsFree.value;
  try {
    localStorage.setItem(VOICE_HF_KEY, voiceHandsFree.value ? "1" : "0");
  } catch (e) {}
  if (voiceHandsFree.value) {
    voiceError.value = "已切换为免按键：说完停顿一下自动发送";
    if (voiceMode.value && voiceState.value === "idle") startHandsFree();
    return;
  }
  cleanupCapture();
  voiceHolding.value = false;
  if (voiceState.value === "listening") voiceState.value = "idle";
  voiceError.value = "已切换为按住说话";
}

// 麦克风按钮：收听中点击=暂停；播报/思考中点击=先打断再听
function toggleListen() {
  if (voiceState.value === "listening") {
    cleanupCapture();
    voiceState.value = "idle";
    voicePaused.value = true;
    voiceError.value = "已暂停收听，点麦克风继续";
    return;
  }
  if (voiceState.value === "speaking" || voiceState.value === "thinking") interruptVoice();
  voicePaused.value = false;
  voiceError.value = "";
  startHandsFree();
}

/* ── 拍照 / 相册 ────────────────────────────────────────── */

function openCamSheet() {
  if (!voiceMode.value) {
    voiceError.value = "还没有对话，先开始语音通话再拍照";
    return;
  }
  // http 页面下浏览器直接拒绝 getUserMedia，提前说明，别让用户点了没反应
  const secure =
    window.isSecureContext ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  voiceCamError.value = secure
    ? ""
    : "当前不是安全连接，页面内相机不可用，请改用系统相机";
  voiceSheetOpen.value = true;
}

async function openInPageCamera() {
  voiceSheetOpen.value = false;
  voiceCamError.value = "";
  voiceCamReady.value = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    voiceError.value = "打不开相机：当前页面环境不支持";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    });
    voiceCamStream = stream;
    voiceCamOpen.value = true;
    await nextTick();
    const v = voiceCamVideo.value;
    if (v) {
      v.srcObject = stream;
      try {
        await v.play();
      } catch (e) {}
    }
    voiceCamReady.value = true;
  } catch (e) {
    const name = e && e.name;
    voiceError.value =
      name === "NotAllowedError"
        ? "相机权限被拒绝，请到系统设置里允许"
        : name === "NotFoundError" || name === "OverconstrainedError"
          ? "相机还没准备好：这台设备没有可用摄像头"
          : "打不开相机：" + ((e && e.message) || "未知原因");
  }
}

function closeCamera() {
  voiceCamOpen.value = false;
  voiceCamReady.value = false;
  if (voiceCamStream) {
    try {
      voiceCamStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
  }
  voiceCamStream = null;
  const v = voiceCamVideo.value;
  if (v) v.srcObject = null;
}

async function shootPhoto() {
  if (!voiceCamReady.value) {
    voiceCamError.value = "相机还没准备好，稍等一下再按";
    return;
  }
  const v = voiceCamVideo.value;
  const w = v ? v.videoWidth : 0;
  const h = v ? v.videoHeight : 0;
  if (!w || !h) {
    voiceCamError.value = "没有取到图片内容，请重试";
    return;
  }
  try {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    cv.getContext("2d").drawImage(v, 0, 0, w, h);
    const blob = await new Promise((resolve) => cv.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) {
      voiceCamError.value = "图片处理失败，请重试";
      return;
    }
    closeCamera();
    await attachImageBlob(blob, "jpg");
  } catch (e) {
    voiceCamError.value = "拍照失败：" + ((e && e.message) || "未知原因");
  }
}

function pickPhotoFile(capture) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  if (capture) input.capture = "environment";
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type || "")) {
      voiceError.value = "这不是图片文件";
      return;
    }
    if (f.size > VOICE_IMAGE_MAX) {
      voiceError.value = "图片太大，单张不能超过 8 MB";
      return;
    }
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
    await attachImageBlob(f, /^(jpg|jpeg|png|webp)$/.test(ext) ? ext : "jpg");
  };
  input.click();
}

function fromAlbum() {
  voiceSheetOpen.value = false;
  pickPhotoFile(false);
}

function useSystemCamera() {
  voiceSheetOpen.value = false;
  voiceError.value = "已改用系统相机";
  pickPhotoFile(true);
}

/* ── 随问附图：先上传拿 image_id，再随语音轮提交 ──────────── */

function releaseAttach() {
  const a = voiceAttach.value;
  if (a && a.url) {
    try {
      URL.revokeObjectURL(a.url);
    } catch (e) {}
  }
  voiceAttach.value = null;
}

function removeAttach() {
  releaseAttach();
  voiceError.value = "";
}

async function attachImageBlob(blob, ext) {
  releaseAttach();
  const seq = ++voiceImageSeq;
  voiceAttach.value = {
    id: "",
    url: URL.createObjectURL(blob),
    status: "uploading",
    error: "",
  };
  voiceError.value = "正在看这张图…";
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), VOICE_UPLOAD_MS);
  try {
    const r = await fetch(
      "/api/v2/voice/image?ext=" +
        encodeURIComponent(ext || "jpg") +
        (voiceConversationId
          ? "&conversation_id=" + encodeURIComponent(voiceConversationId)
          : ""),
      {
        method: "POST",
        headers: {
          "Content-Type": blob.type || "image/jpeg",
          "X-Workbench": "1",
        },
        body: blob,
        signal: ac.signal,
      },
    );
    const j = await r.json().catch(() => ({}));
    if (seq !== voiceImageSeq) return; // 已被更新的图取代
    if (!r.ok) throw new Error(j.error || "上传失败");
    voiceAttach.value = {
      ...voiceAttach.value,
      id: j.image_id || j.id || "",
      status: "ready",
    };
    voiceError.value = "";
  } catch (e) {
    if (seq !== voiceImageSeq) return;
    const aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
    const offline = e && e.name === "TypeError";
    const msg = aborted
      ? "上传超时，请检查网络后重试"
      : offline
        ? "网络中断，图片没传上去"
        : (e && e.message) || "上传失败";
    if (voiceAttach.value) {
      voiceAttach.value = { ...voiceAttach.value, status: "failed", error: msg };
    }
    voiceError.value = msg;
  } finally {
    window.clearTimeout(timer);
  }
}

async function askStreaming(text, epoch = voiceEpoch) {
  const rid = voiceRequestId || newVoiceRequestId();
  voiceState.value = "thinking";
  voicePhase.value = "queued";
  voiceAnswerText.value = "";
  voiceQueue = [];
  voiceSpeaking = false;
  voiceStreamDone = false;
  voiceInterrupted = false;
  const ac = new AbortController();
  voiceAbort = ac;
  let full = "";
  let pending = "";
  try {
    const chosenDomain =
      domain.value && allowedDomainOptions.value.includes(domain.value)
        ? domain.value
        : allowedDomainOptions.value[0];
    const res = await fetch("/api/v2/voice/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench": "1" },
      body: JSON.stringify({
        request_id: rid,
        question: text,
        conversation_id: voiceConversationId || undefined,
        domain: chosenDomain,
        // 附了照片：只带 image_id，图片本身已在 /voice/image 落盘
        image_id:
          voiceAttach.value && voiceAttach.value.id ? voiceAttach.value.id : undefined,
      }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "服务返回 " + res.status);
    }
    releaseAttach(); // 图已随本轮提交，不能跟着下一轮重复发送
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const part = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!part.startsWith("data:")) continue;
        const raw = part.slice(5).trim();
        if (!raw) continue;
        let obj;
        try {
          obj = JSON.parse(raw);
        } catch (e) {
          continue;
        }
        if (obj.type === "meta") {
          if (obj.conversation_id) voiceConversationId = obj.conversation_id;
          if (obj.turn_id) voiceTurnId = obj.turn_id;
          continue;
        }
        if (obj.type === "phase") {
          voicePhase.value = obj.phase;
          continue;
        }
        if (obj.error) throw new Error(obj.error);
        if (obj.delta) {
          // 打断之后迟到的旧答案是"隔轮串音"的来源，一律丢弃
          if (voiceInterrupted || ac.signal.aborted || epoch !== voiceEpoch) continue;
          full += obj.delta;
          pending += obj.delta;
          voiceAnswerText.value = full;
          let m;
          while ((m = pending.match(/^([\s\S]*?[。！？!?；;\n])([\s\S]*)$/))) {
            const sentence = m[1].trim();
            pending = m[2];
            if (sentence) enqueueSpeech(sentence);
          }
        }
        if (obj.done) voicePhase.value = obj.status || "completed";
      }
    }
    if (voiceInterrupted || epoch !== voiceEpoch) return;
    if (pending.trim()) enqueueSpeech(pending.trim());
    voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: full });
    voiceHistory = voiceHistory.slice(-8);
    voiceStreamDone = true;
    refresh().catch(() => {});
    if (!voiceSpeaking && voiceQueue.length === 0) resumeListening();
  } catch (e) {
    if (voiceInterrupted || ac.signal.aborted) return; // 主动打断不算失败
    voiceError.value = e.message || "生成失败";
    voiceState.value = "idle";
    voiceStreamDone = true;
  } finally {
    if (voiceAbort === ac) voiceAbort = null;
  }
}

function newVoiceRequestId() {
  return (
    (window.crypto &&
      typeof window.crypto.randomUUID === "function" &&
      window.crypto.randomUUID()) ||
    "voice-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// 打断：停播 → 清待播 → 取消服务端这一轮 → 丢弃迟到增量/音频
function interruptVoice() {
  voiceInterrupted = true;
  voiceEpoch++; // 作废在途的识别与生成
  try {
    if (voiceAudio) {
      voiceAudio.onended = null;
      voiceAudio.onpause = null;
      voiceAudio.pause();
      voiceAudio.src = "";
      voiceAudio = null;
    }
  } catch (e) {}
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (e) {}
  try {
    const n = voiceNative();
    if (n && typeof n.stopSpeaking === "function") n.stopSpeaking();
    if (n && typeof n.stopListening === "function") n.stopListening();
  } catch (e) {}
  voiceQueue = [];
  voiceSpeaking = false;
  voiceStreamDone = true;
  const asr = voiceAsrAbort;
  voiceAsrAbort = null;
  if (asr) {
    try {
      asr.abort();
    } catch (e) {}
  }
  const ac = voiceAbort;
  voiceAbort = null;
  if (ac) {
    try {
      ac.abort();
    } catch (e) {}
  }
  const turnId = voiceTurnId;
  voiceTurnId = "";
  if (turnId) {
    fetch("/api/v2/turns/" + encodeURIComponent(turnId) + "/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench": "1" },
    }).catch(() => {});
  }
  voicePhase.value = "";
  if (voiceState.value !== "listening") voiceState.value = "idle";
}

// 重试回答：换新请求编号重开一轮（失败轮次留在历史里，便于定位）
function retryAnswer() {
  if (!voiceText.value) return;
  voiceError.value = "";
  voiceRequestId = newVoiceRequestId();
  askStreaming(voiceText.value);
}

function enqueueSpeech(text) {
  const t = stripForSpeech(text);
  if (!t) return;
  voiceQueue.push(t);
  if (!voiceSpeaking) playNext();
}

async function playNext() {
  if (voiceInterrupted) {
    voiceSpeaking = false;
    return;
  }
  const text = voiceQueue.shift();
  if (!text) {
    voiceSpeaking = false;
    if (voiceStreamDone && voiceMode.value) resumeListening();
    return;
  }
  voiceSpeaking = true;
  voiceState.value = "speaking";
  let ok = false;
  if (voiceServer.tts) {
    try {
      await playServerTts(text);
      ok = true;
    } catch (e) {
      ok = false;
    }
  }
  if (!ok) {
    try {
      await playFallbackTts(text);
    } catch (e) {}
  }
  voiceSpeaking = false;
  playNext();
}

function playServerTts(text) {
  return new Promise((resolve, reject) => {
    fetch("/api/v2/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench": "1" },
      body: JSON.stringify({ text }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("TTS " + r.status);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        voiceAudio = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          voiceAudio = null;
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          voiceAudio = null;
          reject(Error("播放失败"));
        };
        // 打断时 pause() 不会触发 onended，这里兜底结束当前句
        audio.onpause = () => {
          URL.revokeObjectURL(url);
          voiceAudio = null;
          resolve();
        };
        audio.play().catch(reject);
      })
      .catch(reject);
  });
}

function playFallbackTts(text) {
  return new Promise((resolve) => {
    const n = voiceNative();
    if (n && typeof n.speak === "function") {
      voiceSpeakResolve = resolve;
      try {
        n.speak(text);
      } catch (e) {
        resolve();
      }
      return;
    }
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.onend = resolve;
      u.onerror = resolve;
      window.speechSynthesis.speak(u);
      return;
    }
    resolve();
  });
}

function resumeListening() {
  // 按住说话：回答结束后只回到"待按住"，不自动开始录音
  if (!voiceMode.value) return;
  cleanupCapture();
  voiceHolding.value = false;
  voiceHoldMs.value = 0;
  voiceCancelArmed.value = false;
  voiceState.value = "idle";
  // 免按键：回答播完后自动继续听，用户不用每轮都点一次
  if (!voiceHandsFree.value || voicePaused.value) return;
  if (voiceHfRestart) window.clearTimeout(voiceHfRestart);
  voiceHfRestart = window.setTimeout(() => {
    voiceHfRestart = 0;
    if (
      voiceMode.value &&
      voiceHandsFree.value &&
      !voicePaused.value &&
      voiceState.value === "idle"
    ) {
      startHandsFree();
    }
  }, VOICE_HF_DELAY_MS);
}

function handleVoiceEvent(ev) {
  if (typeof ev === "string") {
    try {
      ev = JSON.parse(ev);
    } catch (e) {
      return;
    }
  }
  if (!ev || !voiceMode.value) return;
  if (ev.type === "audio") {
    uploadAudio(base64ToBlob(ev.data || "", ev.ext || "m4a"), ev.ext || "m4a");
    return;
  }
  if (ev.type === "partial") {
    voiceText.value = ev.text || "";
  } else if (ev.type === "result") {
    const text = String(ev.text || "").trim();
    voiceText.value = text;
    if (text) askStreaming(text);
  } else if (ev.type === "error") {
    const msg = ev.message || "语音识别失败";
    if (msg.indexOf("忙") >= 0) {
      window.setTimeout(() => {
        if (voiceMode.value) startNativeListening();
      }, 800);
      return;
    }
    voiceError.value = msg;
    if (msg.indexOf("权限") >= 0) {
      showVoiceSetup([
        "麦克风权限被拒绝。",
        "点「打开应用设置」→ 权限 → 麦克风 → 允许，然后重新发起通话。",
      ]);
    } else if (voiceState.value === "listening") {
      voiceState.value = "idle";
    }
  } else if (ev.type === "speakEnd") {
    if (voiceSpeakResolve) {
      const fn = voiceSpeakResolve;
      voiceSpeakResolve = null;
      fn();
    }
  }
}

function stopSpeaking() {
  voiceQueue = [];
  if (voiceAudio) {
    try {
      voiceAudio.pause();
      voiceAudio.currentTime = 0;
    } catch (e) {}
    voiceAudio = null;
  }
  const n = voiceNative();
  try {
    n && n.stopSpeaking();
  } catch (e) {}
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (voiceSpeakResolve) {
    const fn = voiceSpeakResolve;
    voiceSpeakResolve = null;
    fn();
  }
  voiceSpeaking = false;
  if (voiceMode.value) resumeListening();
}

function endCall() {
  unbindHoldPointer();
  document.removeEventListener("visibilitychange", onVoiceVisibility);
  window.removeEventListener("blur", onVoiceBlur);
  voiceHolding.value = false;
  voiceHoldMs.value = 0;
  voiceMode.value = false;
  voiceState.value = "idle";
  voiceSetupOpen.value = false;
  voiceQueue = [];
  voiceSpeaking = false;
  cleanupCapture();
  closeCamera();
  releaseAttach();
  voiceSheetOpen.value = false;
  voicePaused.value = false;
  if (voiceHfRestart) {
    window.clearTimeout(voiceHfRestart);
    voiceHfRestart = 0;
  }
  if (voiceAudio) {
    try {
      voiceAudio.pause();
    } catch (e) {}
    voiceAudio = null;
  }
  const n = voiceNative();
  try {
    n && n.stopListening();
  } catch (e) {}
  try {
    n && n.recCancel();
  } catch (e) {}
  try {
    n && n.stopSpeaking();
  } catch (e) {}
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (voiceSpeakResolve) {
    const fn = voiceSpeakResolve;
    voiceSpeakResolve = null;
    fn();
  }
}

function nativeRequestMic() {
  const n = voiceNative();
  if (n && n.requestMic) {
    voiceSetupOpen.value = false;
    try {
      n.requestMic();
    } catch (e) {}
    window.setTimeout(() => {
      voiceMode.value = true;
      probeAndStart();
    }, 1200);
  }
}

function nativeOpenSettings() {
  const n = voiceNative();
  if (n && n.openAppSettings) {
    try {
      n.openAppSettings();
    } catch (e) {}
  }
}

function stripForSpeech(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " 代码块 ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, "")
    .replace(/^\s*[-·]\s+/gm, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

// 问题领域跟随所属部门，不再让员工手选
watch(
  [departments, user],
  () => {
    if (!user.value || admin.value) return;
    if (!allowedDomainOptions.value.length) {
      domain.value = "";
      upload.value.domain = "";
      return;
    }
    if (!allowedDomainOptions.value.includes(domain.value))
      domain.value = allowedDomainOptions.value[0];
    if (!allowedDomainOptions.value.includes(upload.value.domain))
      upload.value.domain = allowedDomainOptions.value[0];
  },
  { immediate: true }
);

// 点击页面空白处关闭部门「⋯」菜单（触发按钮与菜单项均 @click.stop，不会误关）
const closeDeptMenu = () => {
  if (deptMenu.value) deptMenu.value = "";
};

onMounted(async () => {
  // 接收安卓壳的语音事件
  window.__qingheVoice = handleVoiceEvent;
  document.addEventListener("click", closeDeptMenu);
  try {
    const status = await call("/auth/status");
    setup.value = status.setup_required;
    user.value = status.user;
    if (user.value) {
      await loadDepartments();
      await refresh();
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    ready.value = true;
  }
  timer = setInterval(poll, 3000);
  clock = setInterval(() => (nowTick.value = Date.now()), 1000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  clearInterval(clock);
  if (window.__qingheVoice === handleVoiceEvent) delete window.__qingheVoice;
  document.removeEventListener("click", closeDeptMenu);
  endCall();
});
</script>

<template>
  <div v-if="!user" class="login-screen">
    <section class="login-card">
      <div class="brand-line">
        <Sprout :size="32" /><strong>京阳智农 · 农业 AI 工作台</strong>
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
    <aside class="wb-sidebar" :class="{ open: menuOpen }">
      <div class="brand-line">
        <Sprout :size="27" /><strong
          >京阳智农 <small>AGRI INTELLIGENCE</small></strong
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
        ><button @click="manualCheckUpdate">
          <RefreshCw :size="16" />检查更新</button
        ><button @click="logout"><LogOut :size="16" />退出登录</button>
      </div>
    </aside>
    <div class="sidebar-mask" v-if="menuOpen" @click="menuOpen = false"></div>
    <main class="wb-main">
      <header class="wb-top">
        <button
          class="menu-btn"
          aria-label="菜单"
          @click="menuOpen = !menuOpen"
        >
          <Menu :size="18" />
        </button>
        <span
          >农业 AI 平台 / <strong>{{ title }}</strong></span
        ><span class="badge success">{{ roleNames[user.role] }}</span>
      </header>
      <div class="wb-content">
        <div class="heading">
          <div>
            <h1>{{ title }}</h1>
          </div>
          <button class="outline" :disabled="busy" @click="act(refreshCurrent)">
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
              >
              <div
                v-for="c in conversations"
                :key="c.id"
                :class="['conversation', { selected: c.id === conversationId }]"
              >
                <button class="conv-open" @click="selectConversation(c)">
                  <strong>{{ c.title }}</strong
                  ><small>{{ c.domain }}</small>
                </button>
                <button
                  class="conv-delete"
                  :class="{ confirming: confirmingDelete === c.id }"
                  :title="confirmingDelete === c.id ? '再次点击确认删除' : '删除会话'"
                  @click.stop="deleteConversation(c)"
                  >{{ confirmingDelete === c.id ? "确认删除？" : "删除" }}</button
                >
              </div>
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
                    >第 {{ t.sequence }} 轮 · {{
                      t.candidates.every((c) => c.status === "pending")
                        ? "排队中"
                        : statusNames[t.status]
                    }}</small
                  >
                  <button
                    v-if="
                      t.status === 'generating' &&
                      !t.feedback &&
                      !t.candidates.some((c) => c.status === 'stopped')
                    "
                    class="text-button stop"
                    :disabled="busy"
                    @click="cancelTurn(t)"
                  >
                    停止
                  </button>
                  <p>
                    <span v-if="t.source === 'voice'" class="badge amber"
                      >语音</span
                    >{{ t.question }}
                  </p>
                </div>
                <div
                  class="wb-answers"
                  :class="{ single: t.candidates.length === 1 }"
                >
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
                      <template v-if="c.status === 'pending'">
                        <span style="display:block;font-size:13px;color:#94a3b8;">排队中，请稍候…</span>
                      </template>
                      <template v-else>
                        <span
                          v-if="c.status === 'generating' && t.deep && !c.text"
                          style="display:block;font-size:13px;color:#7c3aed;"
                        >深度思考中… {{ elapsedSeconds(t) }}s</span>
                        <span
                          v-else-if="c.status === 'generating'"
                          style="display:block;font-size:13px;color:#7c3aed;"
                        >正在回答…</span>
                        <span
                          v-else-if="c.status === 'failed'"
                          style="display:block;font-size:13px;color:#dc2626;"
                        >{{ c.error }}</span>
                        <span
                          v-else-if="c.status === 'stopped'"
                          style="display:block;font-size:13px;color:#64748b;"
                        >已停止</span>
                        <span
                          v-else-if="c.status === 'canceled'"
                          style="display:block;font-size:13px;color:#64748b;"
                        >已取消，未生成完整回答</span>
                        <span v-if="c.text" class="cand-text">{{ c.text }}</span>
                      </template>
                    </p>
                  </section>
                </div>
                <div v-if="t.imageTask" class="panel candidate image-card">
                  <h3>
                    配图<small>{{
                      imageStatus[t.imageTask.status] || t.imageTask.status
                    }}</small>
                  </h3>
                  <template
                    v-if="
                      t.imageTask.status === 'completed' &&
                      t.imageTask.filename
                    "
                  >
                    <img
                      :src="'/api/v2/images/' + t.imageTask.id + '/file'"
                      style="
                        max-width: 100%;
                        border-radius: 6px;
                        display: block;
                        margin: 6px 0;
                      "
                      alt="配图"
                    />
                    <a
                      :href="'/api/v2/images/' + t.imageTask.id + '/file'"
                      class="text-button"
                      target="_blank"
                      rel="noopener"
                    >下载图片</a>
                  </template>
                  <span
                    v-else-if="
                      ['queued', 'running'].includes(t.imageTask.status)
                    "
                    style="color:#94a3b8;font-size:13px;"
                  >
                    {{ imageStatus[t.imageTask.status] || t.imageTask.status }}…
                  </span>
                  <span v-else style="color:#dc2626;font-size:13px;">
                    {{ t.imageTask.error || "图片生成失败" }}
                  </span>
                </div>
                <div
                  v-if="
                    t.source !== 'voice' &&
                    t.status === 'generating' &&
                    t.candidates.some((c) => c.status === 'completed') &&
                    t.candidates.some(
                      (c) => !['completed', 'failed'].includes(c.status),
                    )
                  "
                  class="feedback-bar adopt-bar"
                >
                  <span>一条已完成，可先采用它并结束另一条：</span>
                  <button
                    v-for="c in t.candidates"
                    :key="'adopt' + c.label"
                    class="choice"
                    :disabled="busy || c.status !== 'completed'"
                    @click="adopt(t, c.label)"
                  >
                    采用 {{ c.label }} 并结束另一条
                  </button>
                </div>
                <details v-if="t.references?.length" class="references">
                  <summary>
                    本轮参考了 {{ t.references.length }} 个已审核资料片段
                  </summary>
                  <p v-for="r in t.references">
                    {{ r.name }} · v{{ r.version }} · {{ r.location }}
                  </p>
                </details>
                <div
                  v-if="t.status !== 'generating' && t.source !== 'voice'"
                  class="feedback-bar"
                >
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
                <label v-if="!conversationId && allowedDomainOptions.length > 1"
                  >问题领域<select v-model="domain">
                    <option v-for="d in allowedDomainOptions">{{ d }}</option>
                  </select></label
                ><div
                  v-else-if="!conversationId && singleDomain"
                  class="domain-note"
                >
                  问题领域：<strong>{{ singleDomain }}</strong>
                  <small>（按你的所属部门自动确定）</small>
                </div><div
                  v-else-if="!conversationId"
                  class="domain-warn"
                >
                  还没有分配部门，请联系管理员分配后再提问。
                </div><label
                  >{{ turns.length ? "继续追问" : "你的问题"
                  }}<textarea
                    v-model="question"
                    @keydown="onComposerKeydown"
                    @paste="onComposerPaste"
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
                  <div class="composer-tools">
                    <span class="image-pick">
                    <label class="inline-check"
                      ><input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        @change="pickImage"
                      /><ImagePlus :size="16" />附图片（PNG/JPG/WEBP/GIF，≤8MB，随问题发给模型）</label
                    >
                    </span>
                  <button
                    type="button"
                    class="deep-toggle"
                    :class="{ active: deep }"
                    :disabled="busy"
                    :title="deep ? '已开启：本轮使用 27B 深度思考，响应会变慢' : '开启后本轮使用 27B 深度思考，响应会变慢'"
                    @click="deep = !deep"
                  >
                    <Sparkles :size="15" />深度思考
                    <span class="deep-state">{{ deep ? "开" : "关" }}</span>
                  </button>
                </div>
                <small
                  >追问使用你采用的回答；未选择时优先沿用本地有效回答。选择修改不改写已生成的历史。</small
                ><button
                  type="button"
                  class="voice-entry"
                    :disabled="busy || turns.some((t) => t.status === 'generating')"
                    @click="startCall"
                  >
                    <Mic :size="16" />语音通话
                  </button
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
        <template v-if="page === 'images'">
          <section class="panel block">
            <h2>生成图片</h2>
            <p class="subtle intro">
              输入提示词生成图片（本地 FLUX 模型，1024×1024 约 10–20 秒）。
              建议使用英文提示词，贴合度更佳；含精确中文文字的海报请后期排版叠加。
            </p>
            <div class="field-grid">
              <label
                >尺寸<select v-model.number="imageForm.size">
                  <option :value="768">768×768</option>
                  <option :value="1024">1024×1024</option>
                </select></label
              >
            </div>
            <textarea
              v-model="imageForm.prompt"
              rows="3"
              maxlength="2000"
              style="
                width: 100%;
                box-sizing: border-box;
                padding: 10px 12px;
                font: inherit;
                border: 1px solid #d5ddd4;
                border-radius: 6px;
              "
              placeholder="例如：smart greenhouse interior, tomato plants on hydroponic gutters, ripe red fruits, bright daylight"
            ></textarea>
            <button
              class="primary"
              :disabled="imageSubmitting"
              @click="submitImage"
            >
              <ImagePlus :size="16" />{{ imageSubmitting ? "提交中…" : "生成图片" }}
            </button>
          </section>
          <section class="panel block">
            <h2>我的任务</h2>
            <p v-if="imageNotice" class="badge neutral" style="margin: 6px 0">{{ imageNotice }}</p>
            <p v-if="!imageTasks.length" class="empty">还没有图片任务。</p>
            <div v-for="t in imageTasks" :key="t.id" class="list-row">
              <div style="flex: 0 0 128px">
                <img
                  v-if="t.status === 'completed'"
                  :src="imageUrl(t.id)"
                  :alt="t.prompt"
                  loading="lazy"
                  style="
                    width: 128px;
                    height: 128px;
                    object-fit: cover;
                    border-radius: 6px;
                    display: block;
                  "
                />
                <span v-else class="badge neutral">
                  {{ imageStatus[t.status] || t.status }}
                </span>
              </div>
              <div style="flex: 1">
                <strong>{{ t.prompt }}</strong>
                <small>
                  {{ t.width }}×{{ t.height }}
                  <span>· {{ imageStatus[t.status] || t.status }}</span>
                  <span v-if="t.status === 'queued'"> · 等待出图服务接单</span>
                  <span v-if="t.status === 'running'"> · 正在生成（通常 10–20 秒）</span>
                  <span v-if="t.status === 'completed'">
                    · {{ new Date(t.completed_at).toLocaleString() }}
                  </span>
                  <span v-if="t.error" class="badge danger">{{ t.error }}</span>
                  <span
                    v-if="t.cancel_error && ['queued', 'running'].includes(t.status)"
                    class="badge danger"
                    >取消失败：{{ t.cancel_error }}</span
                  >
                </small>
              </div>
              <div style="flex: 0 0 auto">
                <a
                  v-if="t.status === 'completed'"
                  class="text-button"
                  :href="imageUrl(t.id)"
                  :download="'qhe_' + t.id + '.png'"
                  >下载</a
                >
                <button
                  v-if="['queued', 'running'].includes(t.status)"
                  class="text-button"
                  @click="cancelImage(t.id)"
                >
                  取消
                </button>
              </div>
            </div>
          </section>
        </template>
        <template v-if="page === 'documents'">
          <p class="subtle intro">
            上传经验资料，解析清洗后交由领域专家审核。只有已发布文本参与问答检索。
          </p>
          <section class="panel block" v-if="!doc">
            <h2>上传资料</h2>
                <div class="field-grid">
                  <label v-if="allowedDomainOptions.length > 1"
                    >领域<select v-model="upload.domain">
                      <option v-for="d in allowedDomainOptions">{{ d }}</option>
                    </select></label
                  ><label v-else-if="singleDomain"
                    >领域<input :value="singleDomain" readonly /></label
                  ><label v-else
                    >领域<input value="未分配部门，请联系管理员" readonly /></label
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
                  :disabled="busy || !file || !allowedDomainOptions.length"
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
                <span
                  class="badge"
                  :class="docStatusClass(doc.status)"
                  >{{ statusNames[doc.status] }}</span
                >
                · {{ doc.domain }} · {{ doc.source }} · v{{ doc.revision }}
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
              <span
                class="badge"
                :class="docStatusClass(d.status)"
                >{{ statusNames[d.status] }}</span
              >
            </button>
            <p v-if="!docs.length" class="empty">还没有可见资料。</p>
          </section>
        </template>
        <template v-if="page === 'team'">
          <div class="team-page">
            <header class="team-head">
              <p class="subtle team-sub">
                只读查看员工问答 · {{ admin || user.scope_all ? "全部部门" : "本部门" }}
              </p>
              <div class="team-kpis">
                <div><strong>{{ teamStats.conversations || 0 }}</strong><span>会话</span></div>
                <div><strong>{{ teamStats.turns || 0 }}</strong><span>提问</span></div>
                <div><strong>{{ teamStats.people || 0 }}</strong><span>参与人</span></div>
                <div><strong>{{ teamStats.today || 0 }}</strong><span>今日</span></div>
                <div><strong>{{ teamStats.voice || 0 }}</strong><span>语音会话</span></div>
              </div>
            </header>

            <div class="team-filters">
              <input
                v-model="teamFilters.q"
                placeholder="搜索问题标题…"
                @keyup.enter="loadTeam()"
              />
              <div class="sel">
                <button type="button" class="sel-btn" @click.stop="toggleTeamFilter('dept')">
                  <span>{{ teamFilters.dept || "全部部门" }}</span>
                </button>
                <div v-if="teamOpen === 'dept'" class="sel-menu">
                  <button type="button" :class="{ active: !teamFilters.dept }" @click.stop="pickTeamFilter('dept', '')">全部部门</button>
                  <button
                    v-for="d in teamDepartments"
                    :key="d.id"
                    type="button"
                    :class="{ active: teamFilters.dept === d.name }"
                    @click.stop="pickTeamFilter('dept', d.name)"
                  >{{ d.name }}</button>
                </div>
              </div>
              <div class="sel">
                <button type="button" class="sel-btn" @click.stop="toggleTeamFilter('owner')">
                  <span>{{ teamOwnerName }}</span>
                </button>
                <div v-if="teamOpen === 'owner'" class="sel-menu">
                  <button type="button" :class="{ active: !teamFilters.owner }" @click.stop="pickTeamFilter('owner', '')">全部成员</button>
                  <button
                    v-for="u in teamUsers"
                    :key="u.id"
                    type="button"
                    :class="{ active: teamFilters.owner === u.id }"
                    @click.stop="pickTeamFilter('owner', u.id)"
                  >{{ u.name }}</button>
                </div>
              </div>
              <div class="sel">
                <button type="button" class="sel-btn" @click.stop="toggleTeamFilter('range')">
                  <span>{{ teamRangeLabel }}</span>
                </button>
                <div v-if="teamOpen === 'range'" class="sel-menu">
                  <button
                    v-for="r in teamRanges"
                    :key="r.value"
                    type="button"
                    :class="{ active: teamFilters.range === r.value }"
                    @click.stop="pickTeamFilter('range', r.value)"
                  >{{ r.label }}</button>
                </div>
              </div>
              <div v-if="teamOpen" class="sel-mask" @click="teamOpen = ''"></div>
            </div>

            <div class="team-layout">
              <section class="team-list panel">
                <div v-if="teamLoading" class="team-empty">加载中…</div>
                <template v-else>
                  <button
                    v-for="c in teamConvs"
                    :key="c.id"
                    :class="['team-row', { active: teamConv && teamConv.id === c.id }]"
                    @click="openTeamConv(c)"
                  >
                    <span class="team-avatar">{{ (c.owner_name || "?").slice(0, 1) }}</span>
                    <span class="team-row-main">
                      <span class="team-row-top">
                        <strong>{{ c.owner_name }}</strong>
                        <small>{{ relativeTime(c.last_at) }}</small>
                      </span>
                      <span class="team-row-title">{{ c.title }}</span>
                      <span class="team-row-meta">
                        <span class="chip">{{ c.domain }}</span>
                        <span v-if="c.has_voice" class="chip amber">语音</span>
                        <span class="chip">{{ c.turn_count }} 轮</span>
                      </span>
                    </span>
                  </button>
                  <p v-if="!teamConvs.length" class="team-empty">没有符合条件的提问。</p>
                  <div class="team-pager">
                    <button
                      class="outline"
                      :disabled="teamPage <= 1"
                      @click="teamPage--; loadTeam(false)"
                    >上一页</button>
                    <span>{{ teamPage }} / {{ Math.max(1, Math.ceil(teamTotal / 20)) }}</span>
                    <button
                      class="outline"
                      :disabled="teamPage >= Math.ceil(teamTotal / 20)"
                      @click="teamPage++; loadTeam(false)"
                    >下一页</button>
                  </div>
                </template>
              </section>

              <section class="team-detail panel">
                <template v-if="teamConv">
                  <header class="team-detail-head">
                    <div>
                      <h2>{{ teamConv.title }}</h2>
                      <p class="subtle">
                        {{ teamConv.owner_name }} · {{ teamConv.domain }} ·
                        {{ teamConv.turn_count }} 轮 · {{ formatTime(teamConv.created_at) }}
                      </p>
                    </div>
                    <span class="chip">只读</span>
                  </header>
                  <div class="team-thread">
                    <div v-for="t in teamTurns" :key="t.id" class="team-msg">
                      <div class="team-bubble q">
                        <div class="team-who">{{ t.owner_name }}</div>
                        {{ t.question }}
                      </div>
                      <div v-for="c in t.candidates" :key="c.label" class="team-bubble a">
                        <div class="team-who">
                          AI · {{ statusNames[t.status] || t.status }}
                          <span v-if="t.source === 'voice'" class="chip amber">语音</span>
                        </div>
                        <div class="team-answer">{{ c.text || statusNames[c.status] || "无内容" }}</div>
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="team-empty">从左侧选择一条会话查看。</div>
              </section>
            </div>
          </div>
        </template>
        <template v-if="page === 'users' && canManageUsers">
          <div class="org-page">
            <header class="org-head">
              <div>
                <p class="subtle">
                  按部门筛选员工，编辑角色与账号状态。{{
                    admin ? "部门可新增、重命名、停用。" : "仅显示你负责的部门。"
                  }}
                </p>
              </div>
              <button class="primary" @click="openNewUser">＋ 新增员工</button>
            </header>

            <div class="org-layout">
              <aside class="panel org-side">
                <button
                  class="org-side-item"
                  :class="{ active: deptFilter === 'all' }"
                  @click="deptFilter = 'all'"
                >
                  <span>全部员工</span
                  ><span class="org-side-count">{{ users.length }}</span>
                </button>
                <button
                  class="org-side-item"
                  :class="{ active: deptFilter === 'none' }"
                  @click="deptFilter = 'none'"
                >
                  <span>未分配部门</span
                  ><span class="org-side-count">{{ unassignedCount }}</span>
                </button>
                <div class="org-side-sep"></div>
                <div class="org-side-label">部门</div>
                <div
                  v-for="d in activeDepts"
                  :key="d.id"
                  class="org-side-row"
                >
                  <button
                    class="org-side-item"
                    :class="{ active: deptFilter === d.id }"
                    @click="deptFilter = d.id"
                  >
                    <span>{{ d.name }}</span
                    ><span class="org-side-count">{{ deptCount(d.id) }}</span>
                  </button>
                  <div v-if="admin" class="org-more">
                    <button
                      class="org-more-btn"
                      @click.stop="deptMenu = deptMenu === d.id ? '' : d.id"
                    >
                      ⋯
                    </button>
                    <div v-if="deptMenu === d.id" class="org-menu">
                      <button @click.stop="openEditDept(d)">重命名</button>
                      <button
                        @click.stop="
                          toggleDept(d);
                          deptMenu = '';
                        "
                      >
                        {{ d.active !== false ? "停用" : "启用" }}
                      </button>
                      <button
                        class="danger"
                        :disabled="d.user_count > 0 || d.entry_count > 0"
                        :title="
                          d.user_count > 0 || d.entry_count > 0
                            ? '有员工或条目，只能停用'
                            : '删除部门'
                        "
                        @click.stop="
                          deleteDept(d);
                          deptMenu = '';
                        "
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
                <template v-if="inactiveDepts.length">
                  <div class="org-side-label">已停用</div>
                  <div
                    v-for="d in inactiveDepts"
                    :key="d.id"
                    class="org-side-row"
                  >
                    <button
                      class="org-side-item muted"
                      :class="{ active: deptFilter === d.id }"
                      @click="deptFilter = d.id"
                    >
                      <span>{{ d.name }}</span
                      ><span class="org-side-count">{{ deptCount(d.id) }}</span>
                    </button>
                    <div v-if="admin" class="org-more">
                      <button
                        class="org-more-btn"
                        @click.stop="deptMenu = deptMenu === d.id ? '' : d.id"
                      >
                        ⋯
                      </button>
                      <div v-if="deptMenu === d.id" class="org-menu">
                        <button @click.stop="openEditDept(d)">重命名</button>
                        <button
                          @click.stop="
                            toggleDept(d);
                            deptMenu = '';
                          "
                        >
                          启用
                        </button>
                        <button
                          class="danger"
                          :disabled="d.user_count > 0 || d.entry_count > 0"
                          @click.stop="
                            deleteDept(d);
                            deptMenu = '';
                          "
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <button v-if="admin" class="org-add-dept" @click="openNewDept">
                  ＋ 新增部门
                </button>
              </aside>

              <section class="panel org-main">
                <div class="org-toolbar">
                  <input v-model="empSearch" placeholder="搜索姓名 / 账号" />
                  <select v-model="empRole">
                    <option value="">全部角色</option>
                    <option value="employee">普通员工</option>
                    <option value="expert">领域专家</option>
                    <option value="manager">部门管理员</option>
                    <option value="admin">系统管理员</option>
                  </select>
                  <select v-model="empStatus">
                    <option value="">全部状态</option>
                    <option value="active">启用</option>
                    <option value="inactive">停用</option>
                  </select>
                  <button class="outline" @click="resetEmpFilters">重置</button>
                </div>

                <div class="org-table">
                  <div class="org-thead">
                    <span>姓名 / 账号</span><span>所属部门</span
                    ><span>角色</span><span>状态</span><span>操作</span>
                  </div>
                  <div v-for="u in pagedEmployees" :key="u.id" class="org-trow">
                    <div class="org-cell-name">
                      <strong>{{ u.name || u.username }}</strong>
                      <small v-if="u.name && u.name !== u.username">{{
                        u.username
                      }}</small>
                    </div>
                    <div class="org-cell-depts">
                      <template v-if="(u.dept_ids || []).length">
                        <span
                          v-for="id in (u.dept_ids || []).slice(0, 2)"
                          :key="id"
                          class="org-dept-chip"
                          >{{ deptName(id) }}</span
                        >
                        <span
                          v-if="u.dept_ids.length > 2"
                          class="org-dept-more"
                          :title="u.dept_ids.map(deptName).join('、')"
                          >+{{ u.dept_ids.length - 2 }}</span
                        >
                      </template>
                      <span v-else class="org-dept-none">待分配</span>
                    </div>
                    <div class="org-cell-role">
                      <span class="badge" :class="roleBadge(u.role)">{{
                        roleNames[u.role]
                      }}</span>
                      <span
                        v-if="u.scope_all"
                        class="badge amber"
                        title="数据范围：全部部门（含以后新增）"
                        >全部部门</span
                      >
                    </div>
                    <div class="org-cell-status" :class="{ off: !u.active }">
                      <i></i>{{ u.active ? "启用" : "停用" }}
                    </div>
                    <div class="org-cell-actions">
                      <button class="link" @click="openEditUser(u)">编辑</button>
                    </div>
                  </div>
                  <p v-if="!filteredEmployees.length" class="empty-inline">
                    没有符合条件的员工。
                  </p>
                </div>

                <div class="org-pager">
                  <span>共 {{ filteredEmployees.length }} 人</span>
                  <span class="org-pager-pages">
                    <button
                      class="outline"
                      :disabled="empPage <= 1"
                      @click="empPage--"
                    >
                      上一页
                    </button>
                    <span>第 {{ empPage }} / {{ empPageCount }} 页</span>
                    <button
                      class="outline"
                      :disabled="empPage >= empPageCount"
                      @click="empPage++"
                    >
                      下一页
                    </button>
                  </span>
                </div>
              </section>
            </div>

            <div
              v-if="panelOpen"
              class="org-drawer-mask"
              @click="closeUserPanel"
            ></div>
            <aside v-if="panelOpen" class="org-drawer">
              <header class="org-drawer-head">
                <div>
                  <h3>{{ account.id ? "编辑员工" : "新增员工" }}</h3>
                  <small>{{ account.id ? account.username : "创建一个新账号" }}</small>
                </div>
                <button class="org-drawer-close" @click="closeUserPanel">×</button>
              </header>
              <form class="org-drawer-body" @submit.prevent="saveUser">
                <section class="drawer-section">
                  <h4>基本信息</h4>
                  <label
                    >显示姓名<input
                      v-model="account.name"
                      placeholder="昵称或工号" /></label
                  ><label
                    >登录账号<input v-model="account.username" required /></label
                  >
                  <div class="drawer-inline">
                    <span>账号状态</span>
                    <label class="inline-check"
                      ><input
                        type="radio"
                        :value="true"
                        v-model="account.active"
                      />启用</label
                    >
                    <label class="inline-check"
                      ><input
                        type="radio"
                        :value="false"
                        v-model="account.active"
                      />停用</label
                    >
                  </div>
                </section>

                <section class="drawer-section">
                  <h4>部门与权限</h4>
                  <div class="drawer-field">
                    <span>所属部门</span>
                    <div class="dept-chips">
                      <span
                        v-for="id in account.dept_ids"
                        :key="id"
                        class="dept-chip"
                        >{{ deptName(id)
                        }}<button
                          type="button"
                          @click="removeAccountDept(id)"
                        >
                          ×
                        </button></span
                      >
                      <select
                        class="dept-add"
                        :disabled="account.scope_all"
                        @change="
                          addAccountDept($event.target.value);
                          $event.target.value = '';
                        "
                      >
                        <option value="">＋ 选择部门</option>
                        <option
                          v-for="d in accountDeptOptions"
                          :key="d.id"
                          :value="d.id"
                        >
                          {{ d.name }}
                        </option>
                      </select>
                    </div>
                  </div>
                  <label
                    >角色<select v-model="account.role">
                      <option
                        v-for="(label, key) in assignableRoles"
                        :key="key"
                        :value="key"
                      >
                        {{ label }}
                      </option>
                    </select></label
                  >
                  <label v-if="admin" class="inline-check scope-check">
                    <input type="checkbox" v-model="account.scope_all" />
                    全部部门（含以后新增）
                  </label>
                  <p v-if="admin" class="drawer-hint">
                    这是数据范围，可查看和管理全部部门的员工与资料，不等同于系统管理员。
                  </p>
                  <p class="drawer-hint">
                    {{
                      account.role === "manager"
                        ? "可管理所选部门内的员工与资料，不能授予超出范围的权限。"
                        : "可访问所选部门的问答与资料。"
                    }}
                  </p>
                </section>

                <section class="drawer-section">
                  <h4>账号安全</h4>
                  <label
                    >{{
                      account.id ? "重置密码（留空不改）" : "初始密码"
                    }}<input
                      v-model="account.password"
                      type="password"
                      autocomplete="new-password"
                      :required="!account.id"
                      minlength="10"
                      maxlength="128" /></label
                  >
                </section>
              </form>
              <footer class="org-drawer-foot">
                <button type="button" class="outline" @click="closeUserPanel">
                  取消</button
                ><button
                  type="button"
                  class="primary"
                  :disabled="busy"
                  @click="saveUser"
                >
                  保存
                </button>
              </footer>
            </aside>

            <div
              v-if="deptDialog"
              class="org-modal-mask"
              @click.self="deptDialog = false"
            >
              <div class="org-modal">
                <h3>{{ editingDept ? "重命名部门" : "新增部门" }}</h3>
                <input
                  v-model="deptForm.name"
                  placeholder="部门名称"
                  @keyup.enter="saveDept"
                />
                <div class="org-modal-foot">
                  <button class="outline" @click="deptDialog = false">
                    取消</button
                  ><button class="primary" :disabled="busy" @click="saveDept">
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>
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

<!-- 语音通话浮层 -->
<div v-if="voiceMode" class="voice-overlay">
  <div class="voice-card">
    <template v-if="voiceSetupOpen">
      <div class="voice-orb is-idle"><Mic :size="30" /></div>
      <h2 class="voice-title">语音通话需要准备一下</h2>
      <ul class="voice-steps">
        <li v-for="(step, i) in voiceSetupSteps" :key="i">{{ step }}</li>
      </ul>
      <div class="voice-actions">
        <button
          v-if="voiceNative()"
          type="button"
          class="primary"
          @click="nativeRequestMic"
        >
          授权麦克风
        </button>
        <button
          v-if="voiceNative()"
          type="button"
          class="outline"
          @click="nativeOpenSettings"
        >
          打开应用设置
        </button>
        <button type="button" class="outline" @click="endCall">关闭</button>
      </div>
      <p class="voice-tip">授权完成后重新点「语音通话」即可</p>
    </template>

    <template v-else>
      <div class="voice-orb" :class="'is-' + voiceState"><Mic :size="30" /></div>
      <h2 class="voice-title">{{ voiceStateText }}</h2>
      <p class="voice-sub">
        <template v-if="voiceState === 'listening'">
          {{ voiceCancelArmed ? '松开取消，不发送' : (voiceHandsFree ? '我在听，说完停顿一下就会发送' : '松开发送 · 上滑取消') }}
        </template>
        <template v-else-if="voiceState === 'recognizing'">正在把你说的转成文字…</template>
        <template v-else-if="voiceState === 'thinking'">
          {{ voicePhase === 'queued' ? '排队中，马上开始…' : '正在查资料、生成回答，听到第一句就会开念' }}
        </template>
        <template v-else-if="voiceState === 'speaking'">正在朗读，可随时停止</template>
        <template v-else-if="voiceHandsFree">
          {{ voicePaused ? '已暂停收听，点麦克风继续' : (voiceText ? '回答完了，或点下方麦克风可以接着问' : '可以开口问，说一句就开始') }}
        </template>
        <template v-else>按住下方按钮说话，松开发送</template>
      </p>
      <div v-if="voiceState === 'listening'" class="voice-level">
        <i :style="{ width: Math.round(voiceLevel * 100) + '%' }"></i>
      </div>
      <div class="voice-tools">
        <button
          type="button"
          class="voice-tool"
          :disabled="voiceState === 'recognizing'"
          @click="openCamSheet"
          title="拍照提问"
        >
          <Camera :size="16" />拍照
        </button>
        <button
          type="button"
          class="voice-tool"
          :class="{ on: voiceHandsFree }"
          @click="toggleHandsFree"
          :title="voiceHandsFree ? '已切换为按住说话' : '已切换为免按键'"
        >
          <Radio :size="16" />{{ voiceHandsFree ? '免按键' : '按住' }}
        </button>
        <button
          v-if="voiceAttach"
          type="button"
          class="voice-tool"
          @click="removeAttach"
          title="移除这张图"
        >
          <X :size="16" />移除图片
        </button>
      </div>
      <div v-if="voiceAttach" class="voice-attach">
        <img :src="voiceAttach.url" alt="这一轮的照片" />
        <span v-if="voiceAttach.status === 'uploading'">正在上传，稍等一下…</span>
        <span v-else-if="voiceAttach.status === 'failed'" class="err">
          {{ voiceAttach.error || '上传失败' }}
        </span>
        <span v-else>图片已附上，提问时一起上传</span>
      </div>
      <button
        type="button"
        :style="{
          margin: '10px auto 4px',
          padding: '16px 28px',
          minWidth: '220px',
          borderRadius: '999px',
          border: voiceCancelArmed ? '2px solid #d9534f' : '2px solid #153e34',
          background: (voiceHolding || (voiceHandsFree && voiceState === 'listening')) ? (voiceCancelArmed ? '#fdecea' : '#e8f3ef') : '#fff',
          color: voiceCancelArmed ? '#d9534f' : '#153e34',
          fontWeight: 600,
          fontSize: '16px',
          touchAction: 'none',
          userSelect: 'none',
          webkitUserSelect: 'none'
        }"
        @pointerdown.prevent="holdVoiceStart"
        @pointerup.prevent="holdVoiceEnd"
        @pointercancel.prevent="holdVoiceCancel"
        @pointermove="holdVoiceMove"
        @contextmenu.prevent
      >
        <template v-if="voiceRequesting">正在请求麦克风…</template>
        <template v-else-if="voiceHandsFree">
          {{ voiceState === 'listening' ? '暂停收听' : (voicePaused ? '点一下继续听' : '点一下开始说') }}
        </template>
        <template v-else-if="voiceHolding">
          {{ voiceCancelArmed ? '松开取消' : (voiceHoldMs / 1000).toFixed(1) + 's · 松开发送' }}
        </template>
        <template v-else-if="voiceState === 'thinking' || voiceState === 'speaking'">按住打断并提问</template>
        <template v-else>按住说话</template>
      </button>
      <div v-if="voiceText" class="voice-transcript">
        <span class="voice-role">你说</span>{{ voiceText }}
      </div>
      <div v-if="voiceAnswerText" class="voice-transcript answer">
        <span class="voice-role">回答</span>{{ voiceAnswerText }}
      </div>
      <p v-if="voiceError" class="voice-error">{{ voiceError }}</p>
      <button
        v-if="voiceError && voiceText && voiceState === 'idle'"
        type="button"
        class="outline"
        style="margin: 6px auto"
        @click="retryAnswer"
      >
        重试回答
      </button>
      <div class="voice-actions">
        <button
          type="button"
          class="outline"
          :disabled="voiceState === 'listening' || voiceState === 'thinking'"
          @click="resumeListening"
        >
          <Mic :size="16" />再说一次
        </button>
        <button
          v-if="voiceState === 'speaking'"
          type="button"
          class="outline"
          @click="stopSpeaking"
        >
          <Volume2 :size="16" />停止播报
        </button>
        <button type="button" class="voice-hangup" @click="endCall">
          <PhoneOff :size="16" />挂断
        </button>
      </div>
      <p class="voice-tip">
        {{ voiceHandsFree
          ? '免按键：直接说话，停顿一下自动发送；回答播完自动继续听；单次最长 60 秒'
          : '按住说话、松开发送；上滑取消；单次最长 60 秒；回答边生成边朗读' }}
      </p>
    </template>

    <!-- 页面内相机：实时取景 + 快门 -->
    <div v-if="voiceCamOpen" class="voice-cam">
      <video ref="voiceCamVideo" playsinline muted autoplay></video>
      <div class="voice-cam-top">
        <button type="button" class="vc-icon" @click="closeCamera" title="关闭相机">
          <X :size="20" />
        </button>
        <span>对准叶片，按中间白色快门</span>
      </div>
      <div class="voice-cam-bottom">
        <button
          type="button"
          class="vc-shutter"
          :disabled="!voiceCamReady"
          @click="shootPhoto"
        >
          <i></i>
        </button>
      </div>
      <p v-if="voiceCamError" class="voice-cam-error">{{ voiceCamError }}</p>
    </div>

    <!-- 图片来源选择 -->
    <div
      v-if="voiceSheetOpen"
      class="vc-sheet-mask"
      @click.self="voiceSheetOpen = false"
    >
      <div class="vc-sheet">
        <button type="button" @click="openInPageCamera">
          <Camera :size="18" /><span>打开相机（页面内）</span>
        </button>
        <button type="button" @click="fromAlbum">
          <ImagePlus :size="18" /><span>从相册选择</span>
        </button>
        <button type="button" @click="useSystemCamera">
          <Camera :size="18" /><span>系统相机</span>
        </button>
        <p v-if="voiceCamError" class="err">{{ voiceCamError }}</p>
        <button type="button" class="cancel" @click="voiceSheetOpen = false">取消</button>
      </div>
    </div>
  </div>
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
  padding: 20px 38px 30px;
  max-width: 1600px;
  margin: auto;
}
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
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
  position: relative;
  width: 100%;
  border-radius: 7px;
}
.conversation .conv-open {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  padding: 12px;
  gap: 7px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.conv-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  background: transparent;
  border: 0;
  color: #b0483c;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.conversation:hover .conv-delete,
.conv-delete:focus-visible,
.conv-delete.confirming {
  opacity: 1;
}
.conv-delete:hover {
  background: #f6e3e0;
}
.conv-delete.confirming {
  background: #d94f3d;
  color: #fff;
}
.conv-delete.confirming:hover {
  background: #c73e2d;
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
.wb-answers.single {
  grid-template-columns: 1fr;
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
  gap: 8px;
  padding: 8px 16px;
  margin: 2px 0;
  background: #e6f2ec;
  border: 2px solid #2f7d5f;
  border-radius: 999px;
  font-weight: 600;
  font-size: 14px;
  color: #1b5e45;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  box-shadow: 0 1px 4px rgba(31, 94, 70, 0.18);
}
.image-pick .inline-check:hover {
  background: #d3eadd;
  border-color: #1b6b4f;
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(31, 94, 70, 0.22);
}
.image-pick .inline-check:active {
  transform: translateY(0);
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
.wb-top .menu-btn {
  display: none;
}
.sidebar-mask {
  display: none;
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
  .wb-top .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .sidebar-mask {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 50;
  }
  .wb-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 240px;
    height: 100%;
    z-index: 60;
    padding: 20px;
    overflow-y: auto;
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.18);
    transform: translateX(-100%);
    transition: transform 0.25s ease;
  }
  .wb-sidebar.open {
    transform: translateX(0);
  }
  .wb-sidebar > .brand-line {
    font-size: 18px;
  }
  .workspace-label {
    display: none;
  }
  .wb-sidebar nav {
    flex-direction: column;
    align-items: stretch;
    overflow: visible;
    margin-top: 18px;
    padding-bottom: 4px;
  }
  .wb-sidebar nav button {
    white-space: nowrap;
    padding: 12px 10px;
    font-size: 14px;
    width: 100%;
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
  /* 移动端：追问区三列不换行会溢出，导致「发送问题」被挤出屏幕 */
  .form-bottom {
    flex-wrap: wrap;
    align-items: stretch;
    gap: 10px;
  }
  .form-bottom .image-pick {
    width: 100%;
    max-width: 100%;
  }
  .form-bottom .image-pick .inline-check {
    white-space: normal;
    width: 100%;
    max-width: 100%;
    justify-content: flex-start;
    text-align: left;
    line-height: 1.7;
    font-size: 13px;
    padding: 10px 14px;
    border-radius: 10px;
    overflow-wrap: anywhere;
  }
  .form-bottom small {
    width: 100%;
    max-width: 100%;
    flex: 1 1 100%;
  }
  .form-bottom .primary {
    width: 100%;
    white-space: nowrap;
  }
  .composer-v3,
  .composer-v3 .form-bottom {
    max-width: 100%;
    overflow-x: clip;
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
  .voice-entry {
    width: 100%;
  }
}

.composer-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.form-bottom small {
  flex: 1;
  min-width: 0;
}
.deep-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 10px 0 12px;
  border-radius: 999px;
  border: 1px solid #dfe7db;
  background: #fff;
  color: #5f7468;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}
.deep-toggle:hover {
  border-color: #b9d4c0;
  color: #216b50;
  background: #f7fbf5;
}
.deep-toggle.active {
  background: #216b50;
  border-color: #216b50;
  color: #fff;
  box-shadow: 0 2px 10px rgba(33, 107, 80, 0.22);
}
.deep-state {
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  background: #eef3ee;
  color: #7b8f82;
  font-weight: 600;
}
.deep-toggle.active .deep-state {
  background: rgba(255, 255, 255, 0.18);
  color: #d9f3e3;
}

/* ── 语音通话 ─────────────────────────── */
.voice-entry {
  border: 1px solid #cfe3d6;
  background: #eef7f1;
  color: #1f6b4c;
  border-radius: 8px;
  min-height: 40px;
  padding: 10px 14px;
  font-weight: 500;
  white-space: nowrap;
}
.voice-entry:hover:not(:disabled) {
  background: #e2f1e8;
}
.voice-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(12, 34, 27, 0.92);
  backdrop-filter: blur(6px);
}
.voice-card {
  width: 360px;
  max-width: 100%;
  background: #fff;
  border-radius: 22px;
  padding: 30px 24px 22px;
  text-align: center;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
}
.voice-orb {
  width: 92px;
  height: 92px;
  margin: 0 auto 18px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #e6f2ec;
  color: #1f6b4c;
  position: relative;
}
.voice-orb::after {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  border: 2px solid rgba(33, 107, 80, 0.25);
  opacity: 0;
}
.voice-orb.is-listening {
  background: #d8efe3;
}
.voice-orb.is-listening::after {
  opacity: 1;
  animation: voicePulse 1.6s ease-out infinite;
}
.voice-orb.is-thinking {
  background: #f4f1e3;
  color: #8a7a35;
}
.voice-orb.is-thinking::after {
  opacity: 1;
  border-color: rgba(138, 122, 53, 0.3);
  animation: voicePulse 1.2s ease-out infinite;
}
.voice-orb.is-speaking {
  background: #e8f0e2;
}
.voice-orb.is-speaking::after {
  opacity: 1;
  border-color: rgba(80, 120, 60, 0.3);
  animation: voicePulse 1.4s ease-out infinite;
}
@keyframes voicePulse {
  0% {
    transform: scale(1);
    opacity: 0.8;
  }
  100% {
    transform: scale(1.35);
    opacity: 0;
  }
}
.voice-title {
  font-size: 18px;
  color: #21443a;
}
.voice-sub {
  font-size: 12px;
  color: #8d9c95;
  margin-top: 8px;
}
.voice-level {
  height: 6px;
  width: 70%;
  margin: 14px auto 0;
  background: #eef3ee;
  border-radius: 99px;
  overflow: hidden;
}
.voice-level i {
  display: block;
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #8fd3a8, #216b50);
  border-radius: 99px;
  transition: width 80ms linear;
}
.voice-transcript {
  margin-top: 16px;
  padding: 12px 14px;
  background: #f6f9f3;
  border: 1px solid #e6ece0;
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.7;
  color: #3d5447;
  text-align: left;
  min-height: 44px;
  max-height: 160px;
  overflow: auto;
}
.voice-error {
  font-size: 12px;
  color: #b4473a;
  margin-top: 12px;
}
.voice-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 20px;
  flex-wrap: wrap;
}
.voice-actions .outline,
.voice-hangup {
  min-height: 40px;
  padding: 10px 16px;
  border-radius: 8px;
}
.voice-hangup {
  background: #b4473a;
  color: #fff;
}
.voice-hangup:hover {
  background: #9c3b30;
}
.voice-tip {
  font-size: 11px;
  color: #a2ada7;
  margin-top: 16px;
}

.voice-tools {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  margin: 2px auto 6px;
}
.voice-tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid #d7e0db;
  background: #fff;
  color: #4a5a53;
  font-size: 12px;
  cursor: pointer;
}
.voice-tool.on {
  border-color: #153e34;
  background: #e8f3ef;
  color: #153e34;
  font-weight: 600;
}
.voice-tool:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.voice-attach {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  margin: 0 auto 8px;
  font-size: 12px;
  color: #4a5a53;
}
.voice-attach img {
  width: 54px;
  height: 54px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid #d7e0db;
}
.voice-attach .err {
  color: #c0392b;
}

/* 页面内相机 */
.voice-cam {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: #000;
  display: flex;
  flex-direction: column;
}
.voice-cam video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.voice-cam-top {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  color: #fff;
  font-size: 13px;
  background: linear-gradient(#000000aa, #00000000);
}
.vc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 0;
  background: #ffffff26;
  color: #fff;
  cursor: pointer;
}
.voice-cam-bottom {
  position: relative;
  z-index: 2;
  margin-top: auto;
  padding: 24px 0 40px;
  display: flex;
  justify-content: center;
  background: linear-gradient(#00000000, #000000aa);
}
.vc-shutter {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 4px solid #ffffffcc;
  background: transparent;
  padding: 0;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.vc-shutter i {
  display: block;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #fff;
}
.vc-shutter:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.voice-cam-error {
  position: relative;
  z-index: 2;
  margin: 0;
  padding: 8px 16px 16px;
  color: #ffd7d0;
  font-size: 13px;
  text-align: center;
}

/* 图片来源选择 */
.vc-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 61;
  background: #00000066;
  display: flex;
  align-items: flex-end;
}
.vc-sheet {
  width: 100%;
  background: #fff;
  border-radius: 16px 16px 0 0;
  padding: 10px 12px 22px;
  display: grid;
  gap: 6px;
}
.vc-sheet button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px;
  border: 0;
  border-radius: 10px;
  background: #f5f8f6;
  color: #153e34;
  font-size: 15px;
  cursor: pointer;
}
.vc-sheet button.cancel {
  justify-content: center;
  background: transparent;
  color: #7b8a83;
  font-size: 14px;
}
.vc-sheet .err {
  margin: 0;
  padding: 6px 12px;
  color: #c0392b;
  font-size: 12px;
}
.voice-card {
  max-height: 86vh;
  overflow: auto;
}
.voice-steps {
  text-align: left;
  margin: 16px 0 4px;
  padding-left: 18px;
  color: #55705f;
  font-size: 13px;
  line-height: 1.9;
}
.voice-role {
  display: inline-block;
  font-size: 11px;
  color: #7e9187;
  background: #eef3ef;
  border-radius: 4px;
  padding: 1px 6px;
  margin-right: 8px;
  vertical-align: 1px;
}
.voice-transcript.answer {
  background: #f2f7ee;
  border-color: #e0ead7;
  max-height: 220px;
}
.domain-note {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #55705f;
  background: #f2f7ee;
  border: 1px solid #e0ead7;
  border-radius: 8px;
  padding: 10px 12px;
}
.domain-note strong {
  color: #2c6a4c;
}
.domain-note small {
  color: #8d9c95;
  font-size: 12px;
}
.domain-warn {
  font-size: 13px;
  color: #8a5a1f;
  background: #fdf6e7;
  border: 1px solid #f2e3c4;
  border-radius: 8px;
  padding: 10px 12px;
}
.users-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.org-grid {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.org-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #f8faf6;
  border: 1px solid #eef2ed;
  border-radius: 10px;
  padding: 12px;
}
.org-form strong {
  font-size: 13px;
  color: #31493d;
}
.org-list {
  display: flex;
  flex-direction: column;
}
.org-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px solid #f1f4f0;
}
.org-row:last-child {
  border-bottom: 0;
}
.org-row-main strong {
  display: block;
  font-size: 13px;
  color: #31493d;
}
.org-row-main small {
  font-size: 11px;
  color: #8d9c95;
}
.org-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 760px) {
  .org-grid {
    grid-template-columns: 1fr;
  }
}
.users-thead,
.users-trow {
  display: grid;
  grid-template-columns: minmax(130px, 1.2fr) minmax(100px, 0.9fr) minmax(200px, 1.8fr) 64px;
  gap: 12px;
  align-items: center;
  text-align: left;
  width: 100%;
}
.users-thead {
  font-size: 12px;
  color: #93a096;
  padding: 8px 10px;
  border-bottom: 1px solid #eef2ed;
}
.users-trow {
  padding: 14px 10px;
  border-bottom: 1px solid #f1f4f0;
  border-radius: 8px;
}
.users-trow:hover {
  background: #f7faf5;
}
.u-name strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #31493d;
}
.u-name small {
  display: block;
  font-size: 11px;
  color: #93a096;
  margin-top: 3px;
}
.u-dept {
  font-size: 12px;
  color: #5f7268;
}
.u-perm {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-width: 0;
}
.u-roles {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.u-roles .badge {
  font-size: 11px;
  line-height: 1.5;
  padding: 1px 8px;
  border-radius: 999px;
}
.u-perm small {
  font-size: 11px;
  color: #87968d;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.u-status {
  justify-self: start;
  min-width: 52px;
  text-align: center;
}
@media (max-width: 760px) {
  .users-thead {
    display: none;
  }
  .users-trow {
    grid-template-columns: 1fr auto;
    grid-template-areas: "name status" "dept dept" "perm perm";
    gap: 6px 10px;
  }
  .u-name {
    grid-area: name;
  }
  .u-status {
    grid-area: status;
  }
  .u-dept {
    grid-area: dept;
  }
  .u-perm {
    grid-area: perm;
  }
}

.team-page { display: flex; flex-direction: column; gap: 14px; }
.team-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.team-head h1 { font-size: 20px; margin: 0 0 4px; color: #2c4a3b; }
.team-kpis { display: flex; gap: 10px; flex-wrap: wrap; }
.team-kpis > div { background: #f5f9f3; border: 1px solid #e6ede1; border-radius: 10px; padding: 8px 14px; text-align: center; min-width: 66px; }
.team-kpis strong { display: block; font-size: 18px; color: #216b50; }
.team-kpis span { font-size: 11px; color: #8d9c95; }
.team-filters { display: grid; grid-template-columns: minmax(180px, 1.4fr) repeat(3, minmax(120px, 1fr)) auto; gap: 8px; }
.sel { position: relative; }
.sel-btn { width: 100%; height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border: 1px solid #dfe7db; border-radius: 8px; background: #fff; font-size: 13px; color: #33453b; cursor: pointer; }
.sel-btn::after { content: ""; width: 7px; height: 7px; border-right: 1.5px solid #8d9c95; border-bottom: 1.5px solid #8d9c95; transform: rotate(45deg) translateY(-1px); margin-left: 8px; flex-shrink: 0; }
.sel-menu { position: absolute; top: 40px; left: 0; right: 0; background: #fff; border: 1px solid #e5ece1; border-radius: 10px; box-shadow: 0 8px 24px rgba(20, 60, 40, 0.12); padding: 6px; z-index: 40; max-height: 260px; overflow: auto; }
.sel-menu button { display: block; width: 100%; text-align: left; padding: 8px 10px; border-radius: 6px; font-size: 13px; color: #33453b; background: none; border: 0; cursor: pointer; }
.sel-menu button:hover, .sel-menu button.active { background: #eef6ec; color: #216b50; }
.sel-mask { position: fixed; inset: 0; z-index: 30; }
.team-filters input, .team-filters select { height: 36px; padding: 0 10px; }
.team-layout { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 14px; align-items: start; }
.team-list { max-height: calc(100vh - 300px); overflow: auto; padding: 8px; }
.team-row { display: flex; gap: 10px; width: 100%; text-align: left; padding: 10px; border-radius: 10px; border: 1px solid transparent; background: transparent; }
.team-row:hover { background: #f7faf5; }
.team-row.active { background: #eef6ec; border-color: #d9e8d3; }
.team-avatar { width: 34px; height: 34px; border-radius: 50%; background: #dcebdc; color: #2c6a4c; display: inline-flex; align-items: center; justify-content: center; font-weight: 600; flex-shrink: 0; }
.team-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.team-row-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: #31493d; }
.team-row-top small { color: #9aa8a0; font-size: 11px; font-weight: 400; }
.team-row-title { font-size: 12px; color: #6b7d72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-row-meta { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
.team-row-meta .chip { font-size: 10px; padding: 1px 7px; }
.team-empty { color: #94a3a0; font-size: 13px; padding: 24px 12px; text-align: center; }
.team-pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 6px 4px; font-size: 12px; color: #7c8b82; }
.team-detail { min-height: 320px; padding: 16px; }
.team-detail-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; border-bottom: 1px solid #eef2ed; padding-bottom: 10px; margin-bottom: 12px; }
.team-detail-head .chip { flex-shrink: 0; white-space: nowrap; align-self: flex-start; }
.team-detail-head h2 { font-size: 16px; margin: 0 0 4px; color: #2c4a3b; }
.team-thread { display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - 380px); overflow: auto; padding-right: 4px; }
.team-msg { display: flex; flex-direction: column; gap: 8px; }
.team-bubble { border-radius: 12px; padding: 10px 12px; font-size: 14px; line-height: 1.7; }
.team-bubble.q { background: #f4f7f2; color: #33453b; }
.team-bubble.a { background: #fff; border: 1px solid #e9efe6; color: #33453b; }
.team-who { font-size: 11px; color: #8d9c95; margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
.team-answer { white-space: pre-wrap; }
@media (max-width: 900px) {
  .team-filters { grid-template-columns: 1fr 1fr; }
  .team-layout { grid-template-columns: 1fr; }
  .team-list { max-height: 46vh; }
  .team-thread { max-height: none; }
}

/* ── 组织与权限 ───────────────────────── */
.org-page { display: flex; flex-direction: column; gap: 14px; }
.org-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.org-head .subtle { margin: 0; }
.org-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 14px; align-items: start; }
.org-side { padding: 10px; position: sticky; top: 12px; }
.org-side-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: #40564a; background: none; border: 0; cursor: pointer; text-align: left; }
.org-side-item:hover { background: #f5f9f3; }
.org-side-item.active { background: #eaf4e7; color: #1f6b4c; font-weight: 600; }
.org-side-item.muted { color: #9aa8a0; }
.org-side-count { font-size: 11px; color: #8d9c95; background: #f1f4ef; border-radius: 9px; padding: 1px 7px; }
.org-side-item.active .org-side-count { background: #d9ebd3; color: #216b50; }
.org-side-sep { height: 1px; background: #eef2ed; margin: 8px 4px; }
.org-side-label { font-size: 11px; color: #9aa8a0; padding: 8px 10px 4px; }
.org-side-row { display: flex; align-items: center; gap: 2px; }
.org-side-row .org-side-item { flex: 1; min-width: 0; }
.org-more { position: relative; }
.org-more-btn { width: 24px; height: 24px; border: 0; background: none; color: #9aa8a0; cursor: pointer; border-radius: 6px; font-size: 14px; line-height: 1; }
.org-more-btn:hover { background: #eef3ec; color: #40564a; }
.org-menu { position: absolute; right: 0; top: 26px; z-index: 20; background: #fff; border: 1px solid #e6ede1; border-radius: 8px; box-shadow: 0 8px 24px rgba(20, 60, 40, 0.12); padding: 4px; min-width: 112px; }
.org-menu button { display: block; width: 100%; text-align: left; padding: 7px 9px; font-size: 12px; border: 0; background: none; color: #40564a; border-radius: 5px; cursor: pointer; }
.org-menu button:hover { background: #f5f9f3; }
.org-menu button.danger { color: #b4453a; }
.org-menu button:disabled { color: #c3ccc6; cursor: not-allowed; }
.org-add-dept { margin-top: 8px; width: 100%; border: 1px dashed #d9e3d5; background: #fbfdf9; color: #216b50; border-radius: 8px; padding: 8px; font-size: 12px; cursor: pointer; }
.org-main { padding: 12px; min-width: 0; }
.org-toolbar { display: grid; grid-template-columns: minmax(180px, 1fr) 150px 130px auto; gap: 8px; margin-bottom: 10px; }
.org-toolbar input, .org-toolbar select { height: 34px; padding: 0 10px; line-height: normal; }
.org-table { max-height: calc(100vh - 285px); overflow: auto; border: 1px solid #f0f3ef; border-radius: 10px; }
.org-thead, .org-trow { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(130px, 1.1fr) minmax(110px, 0.9fr) 72px 64px; gap: 10px; align-items: center; padding: 0 12px; }
.org-thead { position: sticky; top: 0; z-index: 2; background: #f9fbf7; height: 36px; font-size: 11px; color: #93a096; border-bottom: 1px solid #eef2ed; }
.org-trow { height: 58px; border-bottom: 1px solid #f3f6f2; font-size: 13px; }
.org-trow:last-child { border-bottom: 0; }
.org-trow:hover { background: #fbfdf9; }
.org-cell-name { min-width: 0; }
.org-cell-name strong { display: block; font-size: 13px; color: #31493d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org-cell-name small { display: block; font-size: 11px; color: #9aa8a0; }
.org-cell-depts { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.org-dept-chip { font-size: 11px; background: #f1f5ef; color: #5f7268; border-radius: 5px; padding: 1px 6px; }
.org-dept-more { font-size: 10px; color: #7c8b82; background: #eef3ec; border-radius: 5px; padding: 1px 5px; }
.org-dept-none { font-size: 11px; color: #b98a3a; background: #fdf6e7; border-radius: 5px; padding: 1px 6px; }
.org-cell-role { display: flex; gap: 4px; flex-wrap: wrap; }
.org-cell-role .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; }
.org-cell-status { font-size: 12px; color: #2f7a52; display: flex; align-items: center; gap: 5px; }
.org-cell-status i { width: 6px; height: 6px; border-radius: 50%; background: #3fa46a; display: inline-block; }
.org-cell-status.off { color: #9aa8a0; }
.org-cell-status.off i { background: #c3ccc6; }
.org-cell-actions { text-align: right; }
.org-pager { display: flex; justify-content: space-between; align-items: center; padding: 10px 4px 2px; font-size: 12px; color: #7c8b82; }
.org-pager-pages { display: flex; align-items: center; gap: 8px; }
.org-pager-pages .outline { height: 28px; padding: 0 10px; font-size: 12px; }

.org-drawer-mask { position: fixed; inset: 0; background: rgba(20, 40, 30, 0.28); z-index: 60; }
.org-drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(520px, 100vw); background: #fff; z-index: 61; display: flex; flex-direction: column; box-shadow: -8px 0 30px rgba(20, 60, 40, 0.18); }
.org-drawer-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 20px 12px; border-bottom: 1px solid #eef2ed; }
.org-drawer-head h3 { margin: 0 0 3px; font-size: 16px; color: #2c4a3b; }
.org-drawer-head small { color: #9aa8a0; font-size: 11px; }
.org-drawer-close { border: 0; background: none; font-size: 22px; line-height: 1; color: #8d9c95; cursor: pointer; }
.org-drawer-body { flex: 1; overflow: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 18px; }
.drawer-section { display: flex; flex-direction: column; gap: 10px; }
.drawer-section h4 { margin: 0; font-size: 12px; color: #8d9c95; font-weight: 600; }
.drawer-section label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #5f7268; }
.drawer-section input, .drawer-section select { height: 34px; padding: 0 10px; line-height: normal; }
.drawer-inline { display: flex; align-items: center; gap: 14px; font-size: 12px; color: #5f7268; }
.drawer-inline .inline-check { flex-direction: row; gap: 5px; }
.drawer-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #5f7268; }
.dept-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 34px; }
.dept-chip { display: inline-flex; align-items: center; gap: 4px; background: #eef6ec; color: #216b50; border-radius: 999px; padding: 3px 8px; font-size: 12px; }
.dept-chip button { border: 0; background: none; color: #5f8a72; cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }
.dept-add { height: 32px; border: 1px dashed #cfe0c9; border-radius: 999px; background: #fbfdf9; color: #216b50; font-size: 12px; padding: 0 10px; }
.scope-check { margin-top: 2px; }
.drawer-hint { margin: 0; font-size: 11px; line-height: 1.7; color: #8d9c95; }
.org-drawer-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 20px; border-top: 1px solid #eef2ed; }

.org-modal-mask { position: fixed; inset: 0; background: rgba(20, 40, 30, 0.28); z-index: 70; display: flex; align-items: center; justify-content: center; padding: 20px; }
.org-modal { background: #fff; border-radius: 12px; padding: 18px; width: min(360px, 100%); display: flex; flex-direction: column; gap: 12px; }
.org-modal h3 { margin: 0; font-size: 15px; color: #2c4a3b; }
.org-modal input { height: 36px; padding: 0 10px; }
.org-modal-foot { display: flex; justify-content: flex-end; gap: 8px; }

@media (max-width: 900px) {
  .org-layout { grid-template-columns: 1fr; }
  .org-side { position: static; display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
  .org-side-sep, .org-side-label, .org-side-row { grid-column: 1 / -1; }
  .org-toolbar { grid-template-columns: 1fr 1fr; }
  .org-thead { display: none; }
  .org-trow { grid-template-columns: 1fr auto; height: auto; padding: 10px 12px; gap: 4px 10px; }
  .org-cell-actions { text-align: left; }
}
</style>
