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
  Sparkles,
  Camera,
  Radio,
  X,
  ChevronLeft,
  Square,
  Captions,
  CaptionsOff,
  SlidersHorizontal,
  ChevronUp,
  History,
} from "lucide-vue-next";
import { call, download } from "./workspace-api";
import { uuid, friendlyError, logDiagnostic, compatProbe } from "./compat.js";
// 附图状态机：六态与「什么才算上传成功」都在这份纯逻辑里，便于单测
import * as Attach from "./attach-flow.mjs";
// 请求状态机：提交/轮询/取消的判定都在这里，组件只负责调用（配套 request-state.test.mjs）
import {
  SEND,
  TIMEOUTS,
  createSendTracker,
  createPollScheduler,
  cancelEnabled,
  isDefiniteFailure,
} from "./request-state.mjs";
const user = ref(null),
  ready = ref(false),
  setup = ref(false),
  page = ref("chat"),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
// 启动探测独立：白屏超过 TIMEOUTS.boot 就明说「连不上」并给重试，不再干等 60 秒
const bootState = ref("loading"),
  bootError = ref("");
// 提交 / 取消 / 会话代号：生成中可以刷新、可以取消，各走各的通道
const sendPhase = ref(SEND.IDLE),
  sendDraft = ref(null),
  cancelingTurnId = ref(""),
  convEpoch = ref(0);
// 后台任务清单（不分会话）：切走会话后仍能看到、能回来、能停
const activeTurns = ref([]);
const backgroundTurns = computed(() =>
  activeTurns.value.filter(
    (t) => !conversationId.value || t.conversation_id !== conversationId.value,
  ),
);
const login = ref({ username: "", name: "", password: "" }),
  domains = ["种植管理", "农业物联网", "农业销售", "设计"];
const conversations = ref([]),
  convDrawer = ref(false),
  convQuery = ref(""),
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
// 通话中的对话文字：点「文字」按钮切换显示/隐藏（不是退出通话）
const voiceCaptionOn = ref(true);
// 拍照链路（拉起相机 → 回传 → 压缩 → 出预览）全程要有反馈，否则像没拍上
const shotBusy = ref(false);
const shotBusyText = ref("");
const voiceState = ref("idle"); // idle | listening | thinking | speaking
const voiceText = ref("");
const voiceError = ref("");
// 合成彻底失败（服务端没出音频、本机也没有朗读引擎）时的可见状态。
// 以前这种情况是静默的：文字在往上滚，却一点声音都没有，用户不知道是坏了还是没话。
const voiceTtsWarn = ref(false);
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
const voiceStateText = computed(() => {
  // 暂停要单独说清楚：点了暂停却还显示"直接说话"，用户会以为麦克风开着，
  // 对着手机说半天没反应，最后归咎于"识别不准"。
  if (voicePaused.value && voiceState.value === "idle")
    return voiceHandsFree.value ? "已暂停收听" : "已暂停";
  return (
    {
      idle: voiceHandsFree.value ? "直接说话" : "按住说话",
      listening: voiceHandsFree.value ? "我在听…" : "正在录音…",
      recognizing: "正在识别…",
      thinking: "正在思考…",
      speaking: "正在播报…",
      // 失败是独立一态：不能停在 idle 让人以为"没反应"
      failed: "没成功，可以重试",
    }[voiceState.value] || ""
  );
});

// ── 语音界面视图层（对齐 10-26 那版 vc 布局）─────────────────
// 通话计时：进语音开始走，挂断停
const voiceClockText = ref("00:00");
let voiceClockT0 = 0;
let voiceClockTimer = 0;
function startVoiceClock() {
  stopVoiceClock();
  voiceClockT0 = Date.now();
  voiceClockText.value = "00:00";
  voiceClockTimer = window.setInterval(() => {
    const s = Math.max(0, Math.floor((Date.now() - voiceClockT0) / 1000));
    voiceClockText.value =
      String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}
function stopVoiceClock() {
  if (voiceClockTimer) {
    window.clearInterval(voiceClockTimer);
    voiceClockTimer = 0;
  }
}
// 小球配色只区分 idle / thinking / speaking；收听时用默认绿色（跟着音量放大）
const voiceOrbState = computed(() => {
  const s = voiceState.value;
  if (s === "listening") return "live";
  if (s === "recognizing" || s === "thinking") return "thinking";
  if (s === "speaking") return "speaking";
  return "idle";
});
const voiceHintText = computed(() => {
  if (voiceState.value === "listening")
    return voiceCancelArmed.value
      ? "松开取消，不发送"
      : voiceHandsFree.value
        ? "我在听，说完停顿一下就会发送"
        : "松开发送 · 上滑取消";
  if (voiceState.value === "recognizing") return "正在把你说的转成文字…";
  if (voiceState.value === "thinking")
    return voicePhase.value === "uploading"
      ? "图片还在上传，传完就开始回答…"
      : voicePhase.value === "queued"
        ? "排队中，马上开始…"
        : "正在查资料，听到第一句就开念";
  if (voiceState.value === "speaking") return "正在朗读，可以随时打断";
  if (voiceState.value === "failed") return "这一句没成功，点重试就好";
  if (voicePaused.value) return "已暂停收听，点麦克风继续";
  if (voiceHandsFree.value)
    return voiceText.value ? "回答完了，直接说下一句" : "可以开口问，说一句就开始";
  return "按住下方按钮说话，说完松开";
});
// 大圆按钮上的字：随模式与状态变，不能一直写"按住说话"
const holdLabel = computed(() => {
  if (voiceRequesting.value) return "请求权限";
  if (voiceHandsFree.value)
    return voiceState.value === "listening" ? "暂停收听" : voicePaused.value ? "继续收听" : "开始说";
  if (voiceHolding.value)
    return voiceCancelArmed.value ? "松开取消" : (voiceHoldMs.value / 1000).toFixed(1) + "s";
  if (voiceState.value === "thinking" || voiceState.value === "speaking") return "按住打断";
  return "按住说话";
});
// 附图条配色：六态映射到旧版三套（ok / bad / busy）
function attachToneOf(a) {
  const tone = Attach.describe(a).tone;
  if (tone === "ok") return "ok";
  if (tone === "err") return "bad";
  if (tone === "busy" || tone === "warn") return "busy";
  return "";
}
function attachSubTextOf(a) {
  switch (a && a.status) {
    case "picked":
      return "还没上传，发送时会一起带上";
    case "uploading":
      return "正在传到服务器…";
    case "received":
      // 主文案已经说清"服务器已收到"，这里不再重复
      return "";
    case "analyzing":
      return "正在看这张图…";
    case "done":
      return "分析完成";
    case "failed":
      return "没成功，可以重试";
    default:
      return "";
  }
}
function attachInfoOf(a) {
  return Attach.describe(a);
}
function retryAttachAt(index) {
  const a = attaches.value[index];
  if (!a) return;
  if (Attach.canRetryUpload(a)) retryUploadAttachAt(index);
  else if (Attach.canRetryAnalysis(a)) analyzeAgainAt(index);
}
// 音色与语速：跟旧版一致，存在本地，下次进来自动恢复
const voiceName = ref("");
const voiceRate = ref(1);
try {
  voiceName.value = localStorage.getItem("agri.voice.name") || "";
  const r = Number(localStorage.getItem("agri.voice.rate"));
  voiceRate.value = r === 0.85 || r === 1 || r === 1.15 || r === 1.3 ? r : 1;
} catch (e) {}
watch(voiceName, (v) => {
  try {
    localStorage.setItem("agri.voice.name", v || "");
  } catch (e) {}
});
watch(voiceRate, (v) => {
  try {
    localStorage.setItem("agri.voice.rate", String(v || 1));
  } catch (e) {}
});
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
let clock,
  disposed = false;

// 提交跟踪：token 用于识别「迟到的响应」，切会话后旧 token 一律作废
const sender = createSendTracker({
  onChange: (s) => {
    sendPhase.value = s.phase;
    sendDraft.value = s.draft;
  },
});

// 轮询：上一发回来才安排下一拍，弱网按 3→6→12→24→30 秒退避
const poller = createPollScheduler({
  run: () => poll(),
  onError: (e, fails) => {
    if (disposed) return;
    if (e && e.status === 401) {
      user.value = null;
      return;
    }
    // 偶发一次抖动不刷红条，连续两拍失败才提示，避免弱网时满屏报错
    if (fails >= 2) error.value = friendlyError(e);
  },
});
// JavaScript 层面的异常（不是业务错误）必须留证据：手机上连控制台都看不到。
// 带上能力探测结果，才能判断是不是老 WebView 缺 API。
const SCRIPT_ERROR_RE =
  /is not a function|is not defined|is not a constructor|undefined is not an object|null is not an object|Cannot read propert|Cannot set propert|Unexpected token|Script error/i;

function reportIfScriptError(e) {
  const raw = String((e && e.message) || "");
  if (!SCRIPT_ERROR_RE.test(raw)) return;
  try {
    logDiagnostic("ui-script-error", {
      message: raw + " | " + JSON.stringify(compatProbe()),
      stack: (e && e.stack) || "",
    });
  } catch (err) {}
}

async function act(fn) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e) {
    // 老 WebView 上曾把 "AbortSignal.timeout is not a function" 直接显示在登录框下面，
    // 用户无从判断。现在统一翻成人话，原文与能力探测结果落诊断日志。
    error.value = friendlyError(e);
    reportIfScriptError(e);
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
// 部门列表是否已经回来：页面一能输入就点发送时，部门常常还在路上，
// 那时 allowedDomainOptions 还是空的，直接拦会甩一句"还没有分配部门"——
// 其实只是没加载完。这个标记让 ask() 先等一次，而不是误报。
const deptsLoaded = ref(false);
async function loadDepartments() {
  departments.value = (await call("/departments")).items;
  deptsLoaded.value = true;
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
  convDrawer.value = false;
  error.value = "";
  notice.value = "";
  detail.value = null;
  doc.value = null;
  await act(refresh);
  if (id === "team") {
    try {
      await Promise.all([loadTeamUsers(), loadTeam()]);
    } catch (e) {
      error.value = friendlyError(e);
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

// 会话按「今天 / 昨天 / 近 7 天 / 更早」分组：会话一多，平铺列表很难找。
// 参考的是 ChatGPT / Claude 侧栏的分组方式，只保留最必要的时间桶。
function convBucket(v) {
  const d = new Date(v || 0);
  if (Number.isNaN(d.getTime())) return "更早";
  const now = new Date();
  const startOf = (x) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days <= 7) return "近 7 天";
  return "更早";
}
const convGroups = computed(() => {
  const q = convQuery.value.trim().toLowerCase();
  const rows = conversations.value
    .filter((c) => !q || String(c.title || "").toLowerCase().includes(q))
    .slice()
    .sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || "")),
    );
  const out = [];
  for (const c of rows) {
    const label = convBucket(c.created_at);
    let g = out.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      out.push(g);
    }
    g.items.push(c);
  }
  return out;
});

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
  // 生成中也照样刷新：以前这里的 if (busy) return，正好在最需要看进度的时候把界面冻住
  if (!user.value || bootState.value !== "ready") return;
  // 后台标签页不轮询，切回来时由 visibilitychange 立刻补一拍
  if (typeof document !== "undefined" && document.hidden) return;
  if (!["chat", "images", "reviews", "documents"].includes(page.value)) return;
  try {
    await refresh();
  } finally {
    // 后台任务跟当前会话无关，单独一查；失败不打扰用户
    await loadActiveTurns();
  }
}
// 后台任务清单：列出这个人所有还在生成的轮次（不分会话）。
// 切走会话以后，上一会话那条还在跑的轮次仍然能被看到、能回来、能停，
// 不用靠记忆翻历史去猜它到底停了没有。
let activeAt = 0;
async function loadActiveTurns() {
  if (!user.value || page.value !== "chat") return;
  const now = Date.now();
  if (now - activeAt < 1500) return; // 轮询与手动刷新可能撞在一起
  activeAt = now;
  try {
    const out = await call("/turns?active=1", undefined, undefined, {
      timeoutMs: TIMEOUTS.poll,
    });
    activeTurns.value = Array.isArray(out && out.items) ? out.items : [];
  } catch (e) {
    // 这一查只影响提示条，不能因为它弹错误把主流程打断；
    // 断网时保留上一次结果，下一次轮询再收敛
    if (e && e.status === 401) user.value = null;
  }
}
async function openBackgroundTurn(bt) {
  if (bt.conversation_id && bt.conversation_id !== conversationId.value) {
    await selectConversation({ id: bt.conversation_id, domain: bt.domain || domain.value });
  }
  await refresh();
  await loadActiveTurns();
}
// 会话代号 +1：在途提交的迟到响应一律作废，不能填进新会话，也不能解锁新请求
function bumpConvEpoch() {
  convEpoch.value += 1;
  sender.reset(convEpoch.value);
  cancelingTurnId.value = "";
}
function newConversation() {
  bumpConvEpoch();
  conversationId.value = "";
  turns.value = [];
  question.value = "";
  draft.value = null;
  dropAttach(); // 图跟会话绑定，换会话不能把旧图带过去
  convDrawer.value = false;
}
async function selectConversation(c) {
  bumpConvEpoch();
  conversationId.value = c.id;
  domain.value = c.domain;
  dropAttach();
  convDrawer.value = false;
  // 切会话不能走 act()：act 在忙时直接 return，会出现「点了历史会话但列表是空的」
  try {
    await refresh();
  } catch (e) {
    error.value = friendlyError(e);
    if (e.status === 401) user.value = null;
  }
  await loadActiveTurns();
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
    error.value = friendlyError(e);
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
    error.value = friendlyError(e);
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
let askInflight = false;
async function ask() {
  // 上一轮还没收到回执：再点发送 = 用同一个 request_id 去对账，不会变成第二条
  if (sendPhase.value === SEND.UNCONFIRMED && sendDraft.value) {
    await reconcileSend();
    return;
  }
  if (sendPhase.value === SEND.SENDING) {
    notice.value = "上一条还在等服务器回执，稍等一下；要放弃就点回答上方的「停止」";
    return;
  }
  if (!allowedDomainOptions.value.length && !deptsLoaded.value) {
    // 网络慢时部门列表还没到：等一次再判，别把"没加载完"说成"没分配部门"
    await loadDepartments().catch(() => {});
  }
  if (!allowedDomainOptions.value.length) {
    notice.value = "还没有分配部门，请联系管理员分配后再提问。";
    return;
  }
  if (askInflight) return; // 连点两次不能发两轮
  askInflight = true;
  try {
    // 带图就先等图：全部拿到服务端编号才发。
    // 以前只读 files[0]，第二张悄悄丢掉；现在只要有一张没传上去就停住，
    // 让用户重试或删掉——绝不让模型对着残缺的图编内容。
    let imageIds = [];
    if (attaches.value.length) {
      error.value = "";
      const needWait = attaches.value.some(
        (a) =>
          a.status === Attach.ATTACH.UPLOADING ||
          a.status === Attach.ATTACH.PICKED,
      );
      if (needWait) notice.value = "图片上传中，传完就发送…";
      imageIds = await waitAttachSettled();
      if (imageIds.length < attaches.value.length) {
        const missing = attaches.value.filter((a) => !a.id);
        error.value = missing.some((a) => a.status === Attach.ATTACH.FAILED)
          ? `${missing.length} 张图没传上去：点缩略图上的「重试」，或者删掉这几张只发文字`
          : "图片还在上传，稍等一下再发；也可以删掉只发文字";
        return; // 关键：不发残缺的图
      }
    }
    const ids = imageIds;
    const sameIds =
      (draft.value?.image_ids || []).join(",") === ids.join(",");
    if (
      !draft.value ||
      draft.value.question !== question.value ||
      draft.value.conversation_id !== conversationId.value ||
      Boolean(draft.value.deep) !== Boolean(deep.value) ||
      !sameIds
    )
      draft.value = {
        request_id: uuid(),
        question: question.value,
        domain: domain.value,
        deep: deep.value,
        conversation_id: conversationId.value || undefined,
        // 只带服务端编号：图已由 /voice/image 落盘，顺序就是用户选图的顺序
        image_id: ids[0] || undefined,
        image_ids: ids.length ? ids : undefined,
      };
    // 提交只改「提交态」，不碰全局 busy：生成中依然能刷新、能取消、能切会话
    const token = sender.begin(draft.value, convEpoch.value);
    await sendDraftNow(draft.value, token);
  } finally {
    askInflight = false;
  }
}

// 提交一轮。超时/断网不当「失败」——服务端可能已经建好轮次了，
// 只有 4xx 这种明确拒绝才敢放开锁；其余一律进「状态待确认」，保留同一个 request_id。
async function sendDraftNow(draftObj, token) {
  error.value = "";
  notice.value = "";
  try {
    const t = await call("/turns", draftObj, undefined, {
      timeoutMs: TIMEOUTS.send,
    });
    // 迟到的响应：会话已经切走，这一轮落在旧会话里，不能填进新会话
    if (sender.confirm(token, convEpoch.value) === "stale") {
      notice.value = "上一条已在原来的会话里完成，去「历史会话」可以找到";
      return;
    }
    conversationId.value = t.conversation_id;
    question.value = "";
    draft.value = null;
    dropAttach(); // 图已随本轮提交，收进历史记录
    await refresh();
    await loadActiveTurns();
  } catch (e) {
    if (isDefiniteFailure(e)) {
      // 4xx：确定没有建轮次，可以安全放开并让用户改内容重发
      sender.fail(token, convEpoch.value);
      error.value = friendlyError(e);
      reportIfScriptError(e);
      if (e.status === 401) user.value = null;
      return;
    }
    if (
      sender.markUnconfirmed(token, convEpoch.value, friendlyError(e)) ===
      "stale"
    )
      return;
    notice.value = "没收到服务器回执，正在核对这一条是否已经提交…";
    await reconcileSend();
  }
}

// 对账：先只读查证，再决定要不要补发。
// 1) GET /turns/{request_id} 不建轮次、不改状态、不调模型 —— 查到就说明服务器收下了；
// 2) 只有明确 found:false（服务器确定没有这条）才用同一个 request_id 补发一次；
// 3) 查询本身失败（断网、超时）不动状态，留着继续核，绝不靠重发去赌。
async function reconcileSend() {
  const st = sender.state;
  if (st.phase !== SEND.UNCONFIRMED || !st.draft) return;
  const token = st.token;
  const epoch = convEpoch.value;
  const rid = st.draft.request_id;
  // 迟到的结论不能盖过更新的动作：对账要跨好几次网络往返（弱网下几秒），
  // 这期间用户可能已经开始下一条、或者切了会话。那时这句"已确认"会压在
  // 新请求的错误提示上面，读起来像两条互相打脸的消息。
  const stillCurrent = () =>
    sender.state.token === token && convEpoch.value === epoch;
  let look;
  try {
    look = await call(`/turns/${encodeURIComponent(rid)}`, undefined, undefined, {
      timeoutMs: TIMEOUTS.reconcile,
    });
  } catch (e) {
    if (isDefiniteFailure(e) && e.status === 401) user.value = null;
    sender.markUnconfirmed(token, convEpoch.value, friendlyError(e));
    notice.value = "还连不上服务器，核不了；网络恢复后再点「核对这一条」，不会重复生成";
    return;
  }
  if (look && look.found) {
    if (sender.confirm(token, convEpoch.value) === "stale") return;
    conversationId.value = look.turn.conversation_id || conversationId.value;
    question.value = "";
    draft.value = null;
    dropAttach();
    await refresh();
    await loadActiveTurns();
    if (!stillCurrent()) return;
    notice.value = "已确认：这一条服务器早就收下了，没有重复生成";
    return;
  }
  // 服务器确定没有这条，才补发；request_id 不变，即使它其实刚建好也只会命中幂等分支
  try {
    const t = await call("/turns", st.draft, undefined, {
      timeoutMs: TIMEOUTS.reconcile,
    });
    if (sender.confirm(token, convEpoch.value) === "stale") return;
    conversationId.value = t.conversation_id;
    question.value = "";
    draft.value = null;
    dropAttach();
    await refresh();
    await loadActiveTurns();
    if (!stillCurrent()) return;
    notice.value = t.duplicate ? "已确认：这一条之前就提交成功了" : "已补发成功";
  } catch (e) {
    if (isDefiniteFailure(e)) {
      sender.fail(token, convEpoch.value);
      error.value = friendlyError(e);
      return;
    }
    sender.markUnconfirmed(token, convEpoch.value, friendlyError(e));
    notice.value =
      "网络还没恢复，这一条仍在核对；恢复后点「核对这一条」会继续核同一条，不会重复生成";
  }
}

function onComposerKeydown(e) {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (!question.value.trim()) return;
  ask();
}
async function onComposerPaste(e) {
  const items = e.clipboardData || window.clipboardData;
  if (!items) return;
  // 剪贴板里可能一次有多张（截图工具常见），全部收下，别只取第一张
  const files = [];
  for (const it of items.items || []) {
    if (it.type && it.type.indexOf("image/") === 0) {
      const f = it.getAsFile ? it.getAsFile() : null;
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    try {
      const out = await compressImage(f);
      await pickBlob(out.blob, out.ext || "jpg");
    } catch (err) {
      error.value = "有一张图片读不出来，已跳过";
    }
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
  // 取消必须绕开 busy。以前这里是 act()，而 act 开头就是 if (busy) return，
  // 于是「请求卡住 → busy=true → 停止按钮 :disabled=busy」——最想停的时候偏偏按不了。
  if (
    !cancelEnabled({
      status: t.status,
      cancelingId: cancelingTurnId.value,
      turnId: t.id,
    })
  )
    return;
  cancelingTurnId.value = t.id;
  error.value = "";
  notice.value = "已停止本地等待，正在让服务器确认…";
  try {
    const out = await call(`/turns/${t.id}/cancel`, {}, undefined, {
      timeoutMs: TIMEOUTS.cancel,
    });
    // 服务端分三种回答，界面必须说清楚，不能一律显示"已停止"：
    //   cancel_confirmed：已经停下（排队中取消 / 早已结束）
    //   cancel_pending：中止已发出，收尾还没落库
    if (out && out.cancel_confirmed) {
      notice.value = out.already_terminal
        ? "这一条已经结束，服务端状态未变"
        : "服务端已确认停止";
    } else if (out && out.cancel_pending) {
      notice.value = "停止指令已发出，服务器还在收尾；这条不会再算完成";
    } else {
      notice.value = "已请求停止，正在等服务端确认";
    }
    await refresh();
    await loadActiveTurns();
  } catch (e) {
    // 本地停下 ≠ 服务端停下：这句必须说清楚，否则用户以为已经省了算力
    error.value = "服务端没确认取消，这一轮可能还在生成：" + friendlyError(e);
    await loadActiveTurns();
  } finally {
    cancelingTurnId.value = "";
  }
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
      request_id: uuid(),
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
// 句间停顿的根因：上一句播完才去请求下一句的合成，句与句之间白等一整次往返。
// 改成「当前句还在播的时候就把后面的句子送合成」，播完直接接上，停顿只剩解码时间。
let ttsPrefetch = new Map(); // 句子文本 -> { promise: Promise<Blob>, ac: AbortController }
// 正在"边播边取"的即时合成请求。预取有表可以统一作废，即时请求以前是匿名的：
// 用户一打断，它还在后台跑，占着合成服务还可能被下一句复用成串音。
const ttsInflight = new Set();
const TTS_PREFETCH_AHEAD = 3; // 多备一句，切换时不用等合成
// 中文回答标点密，一句二三十字就断一次会让停顿叠加；攒够一整句再送合成
const VOICE_MIN_SENTENCE = 32;
// 但首句不能等：先把声音放出来，后续才靠长句压停顿
const VOICE_FIRST_SENTENCE = 8;
const VOICE_SENT_RE = /[。！？!?；;\n]/g;
// 首句额外认逗号、顿号、冒号：模型第一句常常二十几个字才出现句号，
// 只等句号的话 VOICE_FIRST_SENTENCE 调多小都没用，第一声照样要等大半秒。
const VOICE_FIRST_SENT_RE = /[。！？!?；;，、：:\n]/g;
let voiceStreamDone = true;
let voiceCapture = null;
let voiceAudio = null;
let voiceSpeakResolve = null;
// 所有还在响的音频。只记 voiceAudio 不够：上一轮被顶掉的那条链可能还留着一个
// <audio> 在出声，新一轮再播就成了"两条回答叠在一起"。
const liveAudios = new Map();
// 播放链轮次号：换轮就 +1，旧的链认出自己被顶掉，立刻退出，不再往下播。
let playbackEpoch = 0;
// 本轮是否已经送出过句子：首句要快，之后才用长句合并
let voiceSpoken = false;
let voiceServer = { ok: false, asr: false, tts: false };
// 打断与状态机：同一 request_id 贯穿 识别→生成→播报，卡在哪一步可以定位
let voiceAbort = null;
let voiceTurnId = "";
let voiceRequestId = "";
let voiceInterrupted = false;
// 上一次提问的原文与结果：重试时复用它，避免同一问题在历史里出现两条
let lastQuestionText = "";
let lastTurnFailed = false;
// 轮次编号：每次录音/识别自增，迟到的旧识别与旧答案一律作废
let voiceEpoch = 0;
let voiceAsrAbort = null;
// 连续识别失败计数：成功即清零。连续两次失败就停止自动重开麦克风，
// 否则网络断了会"失败→自动重听→再失败"无限循环，看起来像卡死。
let voiceAsrFails = 0;
// 分阶段耗时：t0=提交时刻，firstCharMs=首个字到达，firstAudioMs=第一段声音真正播出来。
// 分开记才能回答"是模型慢、还是播报慢"，不能用总耗时一概而论。
let voiceTiming = {
  t0: 0,
  firstCharMs: 0,
  ttsReqMs: 0, // 首句送合成的时刻
  ttsGotMs: 0, // 首句音频到手（blob 下载完）的时刻
  firstAudioMs: 0, // 首句真正出声的时刻
  asrMs: 0,
};
// 本轮实际用到的角色（来自服务端 phase 事件），用于把"走的哪条模型"记进耗时日志
let voiceLastRole = "";
const voicePhase = ref(""); // queued | generating | completed | failed | canceled

// ── 按住说话（PTT）：录音结束由用户动作决定，不依赖停顿检测 ──
const VOICE_MAX_MS = 60000; // 单次上限：到点自动结束并提交
const VOICE_MIN_MS = 300; // 过短视为误触，不提交
const VOICE_WARN_MS = 50000; // 提前 10s 提示
const VOICE_CANCEL_PX = 60; // 上滑取消阈值

// ── 分段超时：每一段失败都要能说清是"哪一段卡住了"，并且都能重来 ──
// 以前只有上传有超时，识别和生成一旦卡住就永远转圈，用户只能退出通话。
const VOICE_ASR_MS = 20000; // 识别：20 秒没结果就放弃，提示再说一次
const VOICE_FIRST_TOKEN_MS = 35000; // 生成：35 秒还没有第一个字就放弃
const VOICE_TTS_MS = 30000; // 合成：30 秒没拿到音频就退回本机朗读
const VOICE_IDLE_PAUSE_MS = 15000; // 连续模式：15 秒没人说话就自动暂停，不空转
const voiceHolding = ref(false);
const voiceHoldMs = ref(0);
const voiceCancelArmed = ref(false);
const voiceRequesting = ref(false);
let voiceHoldStart = 0;
let voiceHoldY = 0;
let voiceHoldSubmitted = false;
let voiceHoldAbort = false;
let voiceWarned = false;
// 一次录音一个会话号：原生的 audio/result 回传时带回来，
// 不是本次的一律丢弃——取消后迟到的回调过去会直接替用户提问
let recSessionId = "";
let recSubmitted = false; // 本次录音的结果只接受一次
let recConfirmOnly = false; // 到单次上限：只转文字，不自动提问
let holdTimer = 0; // 按住计时：原生录音没有 rAF 循环，必须自己数
// 到上限后"文字已就绪，等你确认发送"
const voiceConfirmPending = ref(false);
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

// ── 播报中开口打断（barge-in）──
// 要在 AI 说话时听用户，就必须在播报期间开着麦克风，于是有了"自己打断自己"的风险。
// 三道防线：① 前 700ms 是保护期，只采样不判定（把扬声器泄漏的底噪记成基线）
// ② 阈值取 max(0.05, 基线×2.5)，跟着设备回声消除效果自动调整
// ③ 必须连续 320ms 超阈值才算人声，咳嗽、碰麦、单帧噪声都不触发。
// 播报中"开口就打断"已停用：手机外放时它经常把 AI 自己念的话当成用户开口，
// 表现就是答到一半突然断掉、接着莫名开始录音。改为一律"按住说话"。
// 变量保留，值为 false，startBargeIn 会直接返回。
const voiceBargeIn = ref(false);
let bargeStream = null;
let bargeCtx = null;
let bargeRaf = 0;
// 免提（免按键连续对话）已停用：它会在播报结束后自动开麦，
// 用户根本没准备说话时麦克风就亮着，现场很困惑。一律按住说话。
// 不再读 localStorage，避免老用户本地存着 "1" 又把它打开。

// ── 拍照与随问附图：先上传拿 image_id，再随语音轮提交 ──
const VOICE_IMAGE_MAX = 8 * 1024 * 1024;
const VOICE_UPLOAD_MS = 45000;
// 压缩参数：长边 1600 + 0.86 质量。叶片病斑、虫体这类细节靠像素，压太狠就看不出来
const IMG_MAX_EDGE = 1600;
const IMG_QUALITY = 0.86;
const voiceCamOpen = ref(false);
const voiceCamReady = ref(false);
const voiceCamVideo = ref(null);
const voiceCamError = ref("");
const voiceSheetOpen = ref(false);
const voiceSetOpen = ref(false);
const voicePreviewing = ref(false);
let voicePreviewAudio = null;

const VOICE_PRESETS = [
  { value: "", label: "晓晓", note: "女 · 默认", tag: "自然" },
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓", note: "女 · 标准", tag: "自然" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊", note: "女 · 偏年轻", tag: "轻快" },
  { value: "zh-CN-YunxiNeural", label: "云希", note: "男 · 偏年轻", tag: "平和" },
  { value: "zh-CN-YunjianNeural", label: "云健", note: "男 · 偏沉稳", tag: "有力" },
  { value: "zh-CN-YunyangNeural", label: "云扬", note: "男 · 播音腔", tag: "正式" },
];
// 本地合成（sherpa-onnx + MeloTTS）只有一个女声。以前这里摆着 6 个云端音色，
// 点了根本没反应——用户点完再听，声音没变，只会觉得"设置是坏的"。
// 所以本地模式下只列真实存在的那一个，把"换音色"交给切换引擎。
const LOCAL_VOICE_PRESETS = [
  { value: "", label: "自然女声", note: "女 · 本地", tag: "自然" },
];
function isLocalTts() {
  return voiceServer.ttsEngine === "local";
}
const VOICE_RATES = [
  { value: 0.85, label: "慢" },
  { value: 1, label: "正常" },
  { value: 1.15, label: "稍快" },
  { value: 1.3, label: "快" },
];

function fmtRate(v) {
  return (v === 1 ? "1.0" : String(v)) + "×";
}
const voiceNameLabel = computed(() => {
  const local = voiceServer.ttsEngine === "local";
  const list = local ? LOCAL_VOICE_PRESETS : VOICE_PRESETS;
  const hit = list.find((x) => x.value === (voiceName.value || ""));
  if (!hit) return local ? "自然女声·女" : "晓晓·女";
  const gender = (hit.note.split(" · ")[0] || "").trim();
  return gender ? hit.label + "·" + gender : hit.label;
});
const voiceRateLabel = computed(() => fmtRate(voiceRate.value));

function pickVoice(v) {
  voiceName.value = v;
}

function pickRate(v) {
  voiceRate.value = v;
}

// 试听：和正式播报走同一个合成接口，听到的就是将要用到的声音
async function previewVoice() {
  if (voicePreviewing.value) return;
  if (voiceState.value !== "idle") {
    voiceError.value = "等这一轮说完再试听";
    return;
  }
  voicePreviewing.value = true;
  try {
    const ac = new AbortController();
    const blob = await ttsFetch(
      "您好，我是京阳智农的语音助手，现在用这个声音和快慢和您说话。",
      ac,
    );
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    try {
      a.playbackRate = voiceRate.value || 1;
      a.preservesPitch = true;
      if ("webkitPreservesPitch" in a) a.webkitPreservesPitch = true;
    } catch (e) {}
    voicePreviewAudio = a;
    const done = () => {
      if (voicePreviewAudio === a) voicePreviewAudio = null;
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    };
    a.onended = done;
    a.onerror = done;
    await a.play();
  } catch (e) {
    voiceError.value = "试听失败，检查网络后再试";
  } finally {
    voicePreviewing.value = false;
  }
}
// 本轮附图（可以有多个）：按选择/拍摄顺序排列，每张一个独立状态机
// （picked/uploading/received/analyzing/done/failed，含 id/dedupKey/requestId）。
// 发送时按这个顺序交 image_ids，模型看到的顺序就是用户看到的顺序。
const attaches = ref([]);
const TURN_IMAGE_MAX = 6;
// dedupKey → 原始文件：上传失败重试不用重新拍
let attachRawByKey = new Map();
// 首张：wantsImage 之类的旧判断只需要"有没有图"
const attach = computed(() => attaches.value[0] || Attach.emptyAttach());
// 历史附图点开看原图（手机上不跳浏览器）
const shotZoom = ref("");
/** 一轮实际引用过的图片编号（新数据带 image_ids，旧数据只有单张 attachment_id） */
function turnImageIds(t) {
  if (Array.isArray(t.image_ids) && t.image_ids.length) return t.image_ids;
  if (t.image && t.image.attachment_id) return [t.image.attachment_id];
  return [];
}
function zoomShot(id) {
  if (id) shotZoom.value = "/api/v2/voice/image/" + id;
}
// 拍完/选完先进预览，用户确认才上传：这一步是「预览、重拍、删除」的落点
const camShot = ref(null); // { url, blob, mime, ext }
// 服务端确认本轮引用的附件编号（来自 SSE meta/phase），不是页面上的残留
const turnRefId = ref("");
// 全部图片都能进模型才算"可以发送"：只要有一张没传上去，就不能悄悄丢图
const attachCanSend = computed(
  () => attaches.value.length > 0 && attaches.value.every((a) => Attach.canSend(a)),
);
let voiceCamStream = null;

function showVoiceSetup(steps) {
  voiceSetupSteps.value = steps;
  voiceSetupOpen.value = true;
  voiceState.value = "idle";
}

// ── 安全上下文判定 ──
// 浏览器的麦克风与页内相机只在“安全上下文”里可用：https（任意端口）、http://localhost。
// 通过 http://公网IP 打开时，Chrome 会直接把 navigator.mediaDevices 整个抹掉——
// 不是权限被拒，而是接口压根不存在。所以这两种情况必须分开说，
// 否则用户明明点了“允许”，界面还在说“没有拿到麦克风权限”，只会让人反复授权也没用。
function isSecurePage() {
  try {
    if (window.isSecureContext) return true;
  } catch (e) {}
  const h = location.hostname || "";
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
function hasMediaApi() {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia,
  );
}
// 非安全上下文时的统一指引：说清是“地址不安全”，并给出可直接点的证书下载与 https 入口
function insecurePageSteps(what) {
  const host = location.hostname || "当前地址";
  const port = location.port || "";
  // 生产公网入口是标准 443，所以带 8080 的 http 地址对应的 https 入口不带端口
  const httpsUrl =
    port && port !== "80" && port !== "443" ? `https://${host}:${port}` : `https://${host}`;
  // 首次装证书时浏览器还不信任本站，证书只能走 http 下载（这是根 CA，不是业务数据）
  const caUrl = `http://${host}${port ? ":" + port : ""}/jingyang-ca.crt`;
  return [
    `当前是 http 访问，浏览器在「不安全页面」里不提供${what}接口——不是权限问题，你授权多少次都没用。`,
    {
      text: "① 点此下载根证书 jingyang-ca.crt（下载后按提示安装并信任）",
      href: caUrl,
    },
    `② 装好后改用 https 打开：${httpsUrl}`,
    "也可以改用「京阳智农」安卓应用，应用内录音拍照不受此限制。",
  ];
}

function startCall() {
  voiceMode.value = true;
  startVoiceClock();
  voiceError.value = "";
  voiceText.value = "";
  voiceAnswerText.value = "";
  voiceSetupOpen.value = false;
  voiceHistory = [];
  // 接着当前文字会话继续：否则文字里刚说过的，一进语音就全丢，前后明显不搭
  voiceConversationId = conversationId.value || "";
  // 图不跟过来：上一通电话的图容易和本轮问的东西对不上
  dropAttach();
  disposeShot();
  voiceRequestId = "";
  lastQuestionText = "";
  lastTurnFailed = false;
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

async function uploadAudio(blob, ext, opts = {}) {
  const epoch = ++voiceEpoch; // 本轮识别
  const asrT0 = performance.now();
  voiceState.value = "recognizing";
  voicePhase.value = "";
  voiceRequestId = newVoiceRequestId();
  const asrAbort = new AbortController();
  voiceAsrAbort = asrAbort;
  // 识别卡住不能无限转圈：到点主动放弃
  const asrTimer = window.setTimeout(() => {
    try {
      asrAbort.abort();
    } catch (e) {}
  }, VOICE_ASR_MS);
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
    voiceTiming.asrMs = Math.round(performance.now() - asrT0);
    voiceAsrFails = 0; // 识别通了就清零，失败熔断只针对真正连续的故障
    if (opts.confirmOnly) {
      // 到上限的这段：只把话转成文字留在页面上，发不发由用户决定
      voiceConfirmPending.value = true;
      voiceState.value = "idle";
      voiceError.value = "已到最长录音时间，内容已转成文字，确认无误再发送";
      return;
    }
    await askStreaming(text, epoch);
  } catch (e) {
    if (epoch !== voiceEpoch) return;
    const timedOut = Boolean(e && (e.name === "AbortError" || asrAbort.signal.aborted));
    const why = timedOut
      ? `识别超时（${Math.round(VOICE_ASR_MS / 1000)} 秒没有结果）`
      : e.message || "识别失败";
    voiceAsrFails += 1;
    if (voiceAsrFails >= 2) {
      // 连续两次失败：停下来，别再自动重开麦克风
      voicePaused.value = true;
      voiceState.value = "failed";
      voiceError.value = why + "；已暂停收听，检查网络后点麦克风继续";
      return;
    }
    voiceError.value = why + "，请再说一次";
    resumeListening();
    // 按住模式不会自动开麦：停在「没成功可以重试」，等用户再按一次
    if (!voiceHandsFree.value) voiceState.value = "failed";
  } finally {
    if (asrTimer) window.clearTimeout(asrTimer);
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
    // 识别用的录音必须关掉 AEC 和降噪：
    // 这两个是给"打电话听感"调的，会把辅音（s/sh/x/f）削掉、把气声压平，
    // 人耳听着干净，ASR 反而听不清——实测「蛭石」「湿度」这类音最容易糊。
    // autoGainControl 保留：大棚里说话声小，增益帮忙。
    // 注意：播报期间的"打断检测"（startBargeIn）仍要开 AEC，
    // 否则它会把自己的播报声当成用户在说话。
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
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
    const cap = { stream, ctx, rec, chunks, raf: 0, stopped: false, startedAt: performance.now() };
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
        // 一直没人说话就自动暂停：开着麦空转会让界面永远停在"我在听"，
        // 用户以为在等他说话，其实他在忙别的，回来发现还在"听"、什么也没录。
        if (!voiceVoicedMs && now - cap.startedAt >= VOICE_IDLE_PAUSE_MS) {
          voicePaused.value = true;
          cleanupCapture();
          voiceState.value = "idle";
          voiceError.value = "一段时间没听到说话，已暂停收听。点麦克风继续";
          return;
        }
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
          // 到上限：结束录音，但不替用户发送——转成文字等他确认
          recConfirmOnly = true;
          holdVoiceEnd("max");
          return;
        }
      }
      cap.raf = requestAnimationFrame(tick);
    };
    cap.raf = requestAnimationFrame(tick);
  } catch (e) {
    // 两种失败必须分开：接口不存在（页面不安全）≠ 权限被拒
    if (!hasMediaApi()) {
      voiceError.value = "当前页面不是安全连接，浏览器不提供麦克风接口";
      voiceState.value = "idle";
      showVoiceSetup(insecurePageSteps("麦克风"));
      return;
    }
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

function newRecSessionId() {
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 按住计时。Web 录音靠 requestAnimationFrame 更新，原生录音没有这个循环，
 * 所以统一用一个 interval：原生路径也必须有自己的上限提示与到限处理。
 */
function startHoldTimer() {
  stopHoldTimer();
  holdTimer = window.setInterval(() => {
    if (!voiceHolding.value) return;
    const held = performance.now() - voiceHoldStart;
    voiceHoldMs.value = held;
    if (!voiceWarned && held >= VOICE_WARN_MS) {
      voiceWarned = true;
      voiceError.value = "还有 10 秒到单次上限，到点会转成文字，发不发由你决定";
    }
    if (held >= VOICE_MAX_MS) {
      // 到上限不擅自发送：停录 → 识别 → 文字留在页面，等用户点「确认发送」
      recConfirmOnly = true;
      holdVoiceEnd("max");
    }
  }, 200);
}

function stopHoldTimer() {
  if (holdTimer) {
    window.clearInterval(holdTimer);
    holdTimer = 0;
  }
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
  // 只要还有声音就先把声音全停掉，不依赖 state 判断：
  // 状态一旦不同步（比如播完没回 idle），就会出现"A 还在念、用户在说、接着 B 又开始念"。
  stopPlaybackNow();
  // 再按一次 = 打断：立即停播、清待播、取消上一轮生成，然后开始新录音
  if (voiceState.value === "thinking" || voiceState.value === "speaking") interruptVoice();
  voiceInterrupted = false; // 新一轮开始：旧轮次的隔离由 voiceEpoch 负责
  if (!hasMediaApi()) {
    if (!voiceNativeCaps.rec && !voiceNativeCaps.asr) {
      // 关键：这里不是“权限被拒”，是页面不在安全上下文，浏览器连接口都没给。
      // 旧文案让用户以为要去授权，授权多少次都没用。
      voiceError.value = "当前页面不是安全连接，浏览器不提供麦克风接口";
      showVoiceSetup(insecurePageSteps("麦克风"));
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
  voiceConfirmPending.value = false;
  recSessionId = newRecSessionId();
  recSubmitted = false;
  recConfirmOnly = false;
  startHoldTimer();

  const n = voiceNative();
  if (voiceNativeCaps.rec && n && n.recStart) {
    try {
      // 必须明确告诉壳这是「按住说话」：否则壳按静音 900ms / 15 秒上限
      // 自己 stopRec(true)，用户手指还没松开，录音已经上传了
      if (typeof n.recStartHold === "function") n.recStartHold(recSessionId);
      else n.recStart(); // 旧壳没有按住模式，只能靠下面的标志兜住
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
  stopHoldTimer();
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
  stopHoldTimer();
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

// 播报期间监听用户是否开口。拿不到麦克风就安静放弃，不影响正常播报。
async function startBargeIn() {
  if (!voiceHandsFree.value || !voiceBargeIn.value) return;
  if (bargeStream) return;
  if (!voiceMode.value || voiceState.value !== "speaking") return;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // 等权限的这些毫秒里可能已经播完/被打断/退出通话，别留半开的麦克风
    if (!voiceMode.value || voiceState.value !== "speaking") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const startedAt = performance.now();
    let base = 0; // 保护期采到的"播报泄漏"基线
    let loudSince = 0;
    bargeStream = stream;
    bargeCtx = ctx;
    const tick = () => {
      if (!bargeStream || voiceState.value !== "speaking") return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      if (performance.now() - startedAt < 700) {
        if (rms > base) base = rms; // 保护期只观察，不判定
      } else {
        const threshold = Math.max(0.05, base * 2.5);
        if (rms > threshold) {
          if (!loudSince) loudSince = performance.now();
          if (performance.now() - loudSince >= 320) {
            stopBargeIn();
            handleBargeIn();
            return;
          }
        } else {
          loudSince = 0;
        }
      }
      bargeRaf = requestAnimationFrame(tick);
    };
    bargeRaf = requestAnimationFrame(tick);
  } catch (e) {
    try {
      stream && stream.getTracks().forEach((t) => t.stop());
    } catch (e2) {}
    stopBargeIn();
  }
}

function stopBargeIn() {
  if (bargeRaf) {
    try {
      cancelAnimationFrame(bargeRaf);
    } catch (e) {}
    bargeRaf = 0;
  }
  try {
    if (bargeStream) bargeStream.getTracks().forEach((t) => t.stop());
  } catch (e) {}
  try {
    if (bargeCtx) bargeCtx.close();
  } catch (e) {}
  bargeStream = null;
  bargeCtx = null;
}

function handleBargeIn() {
  // 用户开口：停播 + 取消这一轮，立刻转入录音。
  // 这是"用户主动打断"，不该显示成失败，所以清掉错误文案。
  interruptVoice();
  voiceError.value = "";
  startHandsFree();
}

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
  // 一律先给选择面板：拍照和相册两条路都得留着。
  // 之前为了省一次点击，http 下直接拉相机，结果相册入口消失，用户只能拍照。
  voiceCamError.value = "";
  voiceError.value = "";
  voiceSheetOpen.value = true;
}

async function openInPageCamera() {
  voiceSheetOpen.value = false;
  voiceCamError.value = "";
  voiceCamReady.value = false;
  if (!hasMediaApi()) {
    // 兜底：即使被调到，也直接转系统相机，而不是只弹一句错误
    voiceError.value = "当前是普通连接，已改用系统相机";
    pickPhotoFile(true);
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
    // 先出预览，用户点「用这张」才上传：拍糊了可以立刻重拍
    showShot(blob, "jpg");
  } catch (e) {
    voiceCamError.value = "拍照失败：" + ((e && e.message) || "未知原因");
  }
}

// 等待遮罩的唯一出口：正常完成、取消、超时、回到前台找不到文件都走它
let activeShotInput = null;
let shotWaitTimer = 0;
let shotVisBound = false;

function clearShotWait() {
  shotBusy.value = false;
  shotBusyText.value = "";
  if (shotWaitTimer) {
    window.clearTimeout(shotWaitTimer);
    shotWaitTimer = 0;
  }
  const inp = activeShotInput;
  activeShotInput = null;
  if (inp) {
    try {
      if (inp.parentNode) inp.parentNode.removeChild(inp);
    } catch (e) {}
  }
}

// 用户点「取消」：相机可能还开着，只能撤掉网页这边的等待层
function cancelShotWait() {
  clearShotWait();
}

// 从系统相机/相册返回时会切回前台；此时输入框里没有文件就说明用户放弃了。
// WebView 里 focus 不一定触发，visibilitychange 更可靠。
function bindShotVisibility() {
  if (shotVisBound) return;
  shotVisBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !shotBusy.value) return;
    window.setTimeout(() => {
      const inp = activeShotInput;
      if (inp && !(inp.files && inp.files.length)) clearShotWait();
    }, 700);
  });
}

function pickPhotoFile(capture) {
  // 拉起相机 → 拍完回传 → 压缩 → 出预览，中间有好几秒是空白期，
  // 不给提示用户会以为没拍成功又反复点。
  bindShotVisibility();
  if (capture) {
    shotBusy.value = true;
    shotBusyText.value = "已打开相机，拍好后自动处理…";
    // 用户可能直接把相机划掉、或者相机崩了，onchange 永远不来。
    // 30 秒兜底，避免"已打开相机"永久挂在屏幕上。
    if (shotWaitTimer) window.clearTimeout(shotWaitTimer);
    shotWaitTimer = window.setTimeout(() => {
      shotWaitTimer = 0;
      if (shotBusy.value) clearShotWait();
    }, 30000);
  }
  const input = document.createElement("input");
  activeShotInput = input;
  input.type = "file";
  input.accept = "image/*";
  // 相册支持一次选多张；拍照仍然一张一张来（系统相机不返回多张）
  if (capture) input.capture = "environment";
  else input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    cleanup();
    if (!files.length) {
      clearShotWait();
      return;
    }
    shotBusy.value = true;
    // 超出本轮上限的截掉并明说，不能悄悄只传前几张
    const room = Math.max(0, TURN_IMAGE_MAX - attaches.value.length);
    const take = files.slice(0, room);
    if (files.length > take.length)
      voiceError.value = `一次最多带 ${TURN_IMAGE_MAX} 张图，已取前 ${take.length} 张`;
    let done = 0;
    for (const f of take) {
      shotBusyText.value =
        take.length > 1
          ? `正在处理第 ${done + 1}/${take.length} 张…`
          : "正在处理照片…";
      if (!/^image\//.test(f.type || "")) {
        voiceError.value = "有文件不是图片，已跳过";
        continue;
      }
      if (f.size > VOICE_IMAGE_MAX) {
        voiceError.value = "有图片超过 8 MB，已跳过";
        continue;
      }
      const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
      const safeExt = /^(jpg|jpeg|png|webp)$/.test(ext) ? ext : "jpg";
      try {
        const out = await compressImage(f);
        // 语音面板里单张仍走预览（可重拍/确认）；文字输入区没有那块预览，
        // 单张也直接排队上传，否则用户拍完会卡在"看不到预览"的空白里
        if (take.length === 1 && voiceMode.value)
          showShot(out.blob, out.ext || safeExt);
        else await pickBlob(out.blob, out.ext || safeExt);
        done += 1;
      } catch (e) {
        voiceError.value = "有一张图片读不出来，已跳过";
      }
    }
    clearShotWait();
  };
  // 必须先把 input 挂进文档再 click()：安卓 Chrome / 多数 WebView 里，
  // 对一个没有插入 DOM 的 input 调 click() 不会拉起相机或文件选择器，
  // 表现为"点了系统相机什么也没发生"。input 用完立刻从 DOM 摘掉。
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.width = "1px";
  input.style.height = "1px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  const cleanup = () => {
    try {
      if (input.parentNode) input.parentNode.removeChild(input);
    } catch (e) {}
  };
  // 用户直接返回（取消）时 onchange 不会触发，靠 focus 兜底清理，避免 input 残留
  window.addEventListener(
    "focus",
    () => {
      setTimeout(() => {
        if (document.body.contains(input) && !(input.files && input.files.length)) {
          cleanup();
          // 用户取消拍照：等待提示也要撤掉
          clearShotWait();
        }
      }, 800);
    },
    { once: true },
  );
  input.click();
}

function fromAlbum() {
  voiceSheetOpen.value = false;
  pickPhotoFile(false);
}

function useSystemCamera() {
  voiceSheetOpen.value = false;
  voiceError.value = "";
  pickPhotoFile(true);
}

/* ── 预览：拍完/选完先给用户看一眼，确认后才上传 ──────────── */


function showShot(blob, ext) {
  disposeShot();
  camShot.value = {
    url: URL.createObjectURL(blob),
    blob,
    ext: ext || "jpg",
    bytes: blob.size,
  };
}

function disposeShot() {
  const s = camShot.value;
  if (s && s.url) {
    try {
      URL.revokeObjectURL(s.url);
    } catch (e) {}
  }
  camShot.value = null;
}

/** 重拍：丢掉预览，重新打开取景 */
function retakeShot() {
  disposeShot();
  openInPageCamera();
}

/** 取消选图：什么都不上传，正常文字/语音交流不受影响 */
function cancelShot() {
  disposeShot();
  voiceError.value = "";
}

/** 确认用这张：进入「已选中 → 上传中」 */
async function confirmShot() {
  const s = camShot.value;
  if (!s) return;
  const blob = s.blob,
    ext = s.ext;
  disposeShot();
  await pickBlob(blob, ext);
}

/**
 * 选图/拍照后的压缩：长边限 1600px，JPEG 0.86。
 * 叶片病斑、虫体这些诊断细节靠像素，所以不做激进压缩，也不改长宽比。
 * 解码失败（非图片/损坏文件）会抛错，由调用方提示换一张。
 */
async function compressImage(file) {
  const type = file.type || "";
  const extFromType = /png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpg";
  // 小图直接原样用，避免二次编码损失细节
  if (file.size <= 900 * 1024 && /^image\/(jpeg|png|webp)$/.test(type))
    return { blob: file, ext: extFromType };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    throw new Error("图片解码失败");
  }
  const w = bitmap.width,
    h = bitmap.height;
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale)),
    th = Math.max(1, Math.round(h * scale));
  const cv = document.createElement("canvas");
  cv.width = tw;
  cv.height = th;
  cv.getContext("2d").drawImage(bitmap, 0, 0, tw, th);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve) =>
    cv.toBlob(resolve, "image/jpeg", IMG_QUALITY),
  );
  if (!blob) throw new Error("图片处理失败");
  return { blob, ext: "jpg" };
}

/* ── 随问附图：先上传拿 image_id，再随语音轮提交 ──────────── */

/** 选中一张图 → 立即开始上传（状态机负责区分「已选中」和「服务器已接收」） */
async function pickBlob(blob, ext) {
  if (!/^image\//.test(blob.type || "image/jpeg")) {
    voiceError.value = "这不是图片文件";
    return;
  }
  if (blob.size > VOICE_IMAGE_MAX) {
    voiceError.value = "图片太大，单张不能超过 8 MB";
    return;
  }
  if (attaches.value.length >= TURN_IMAGE_MAX) {
    voiceError.value = `一次最多带 ${TURN_IMAGE_MAX} 张图，先删一张再加`;
    return;
  }
  const next = Attach.pick(Attach.emptyAttach(), {
    url: URL.createObjectURL(blob),
    mime: blob.type || "image/jpeg",
    bytes: blob.size,
    at: Date.now(),
  });
  attachRawByKey.set(next.dedupKey, { blob, ext });
  // 追加而不是替换：连拍/连选多张时，前一张不能被后一张顶掉
  attaches.value = [...attaches.value, next];
  turnRefId.value = "";
  voiceError.value = "";
  await uploadAttach(next.dedupKey);
}

function attachIndexOf(key) {
  return attaches.value.findIndex((a) => a.dedupKey === key);
}

function setAttachAt(index, next) {
  if (index < 0 || index >= attaches.value.length) return;
  const list = attaches.value.slice();
  list[index] = next;
  attaches.value = list;
}

/** 对每张已上传的图套同一个状态迁移（分析完成/失败/取消） */
function markAllAttaches(fn) {
  for (const a of attaches.value) {
    if (!a.id) continue;
    setAttachAt(attachIndexOf(a.dedupKey), fn(a));
  }
}

/**
 * 上传。同一个 dedupKey 贯穿所有重试：
 * 网络抖动导致重复提交时，服务端复用原图，不会重复落盘。
 * 接口一次请求就完成「落盘 + 记录」，所以这里不显示百分比——不编造进度。
 */
async function uploadAttach(key) {
  const start = attachIndexOf(key);
  if (start < 0) return;
  const raw = attachRawByKey.get(key);
  if (!raw) {
    setAttachAt(start, Attach.uploadFail(attaches.value[start], "这张图已失效，请重新拍照"));
    voiceError.value = "这张图已失效，请重新拍照";
    return;
  }
  setAttachAt(start, Attach.startUpload(attaches.value[start]));
  if (attaches.value[start].status !== Attach.ATTACH.UPLOADING) return;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), VOICE_UPLOAD_MS);
  try {
    const r = await fetch(
      "/api/v2/voice/image?ext=" +
        encodeURIComponent(raw.ext || "jpg") +
        "&dedup_key=" +
        encodeURIComponent(key) +
        (() => {
          // 语音轮走 voiceConversationId，文字轮走 conversationId：
          // 带错会话号，服务端会以「该图片属于其他会话」把图挡掉
          const cid = voiceMode.value
            ? voiceConversationId
            : conversationId.value;
          return cid ? "&conversation_id=" + encodeURIComponent(cid) : "";
        })(),
      {
        method: "POST",
        headers: {
          "Content-Type": raw.blob.type || "image/jpeg",
          "X-Workbench": "1",
        },
        body: raw.blob,
        signal: ac.signal,
      },
    );
    const j = await r.json().catch(() => ({}));
    // 上传期间这张图被删掉了 → 这次结果作废（不能盖到别的图上）
    const at = attachIndexOf(key);
    if (at < 0) return;
    if (!r.ok) throw new Error(j.error || "上传失败");
    setAttachAt(
      at,
      Attach.uploadOk(attaches.value[at], {
        imageId: j.image_id || j.id || "",
        duplicate: j.duplicate === true,
      }),
    );
    voiceError.value = "";
  } catch (e) {
    const at = attachIndexOf(key);
    if (at < 0) return;
    const aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
    const offline = e && e.name === "TypeError";
    const msg = aborted
      ? "上传超时，请检查网络后重试"
      : offline
        ? "网络中断，图片没传上去"
        : (e && e.message) || "上传失败";
    setAttachAt(at, Attach.uploadFail(attaches.value[at], msg));
    voiceError.value = msg;
    // 失败保留待发送内容：图还在、问题还在，重试不会重复建轮次
  } finally {
    window.clearTimeout(timer);
  }
}

function retryUploadAttachAt(index) {
  const a = attaches.value[index];
  if (!a) return;
  voiceError.value = "";
  uploadAttach(a.dedupKey);
}

/** 删掉第 index 张：本地文件、缩略图、状态一起清掉 */
function removeAttachAt(index) {
  const a = attaches.value[index];
  if (!a) return;
  if (shotZoom.value === a.url) shotZoom.value = "";
  if (a.url) {
    try {
      URL.revokeObjectURL(a.url);
    } catch (e) {}
  }
  if (a.dedupKey) attachRawByKey.delete(a.dedupKey);
  const list = attaches.value.slice();
  list.splice(index, 1);
  attaches.value = list;
  turnRefId.value = "";
  voiceError.value = "";
}

/** 清空本轮全部附图（切会话、挂断、改为只发文字） */
function dropAttach() {
  shotZoom.value = "";
  for (const a of attaches.value) {
    if (a && a.url) {
      try {
        URL.revokeObjectURL(a.url);
      } catch (e) {}
    }
    if (a && a.dedupKey) attachRawByKey.delete(a.dedupKey);
  }
  attaches.value = [];
  attachRawByKey = new Map();
  turnRefId.value = "";
}

function removeAttach() {
  dropAttach();
  voiceError.value = "";
}

/**
 * 等这张图的上传真正结束。
 *
 * 旧实现叫 waitAttachUploaded(4000)：最多等 4 秒，超时就返回空串，
 * 调用方随即把问题以"不带图"发出去。用户明明选了图，AI 却在"看图"的
 * 语境下凭空回答——这不只是体验问题，是让模型对着不存在的图编内容。
 *
 * 现在等的是"状态不再是上传中"，而不是"等到某个时间点"：
 * 上传自身有超时（VOICE_UPLOAD_MS），不会无限挂着；
 * 这里的 ms 只是兜底上限，到点也算它有结论。
 * 传完了返回 image_id；失败/被取消返回空串，由调用方拦下不发。
 */
async function waitAttachSettled(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = attaches.value;
    if (!list.length) return [];
    // 只要还有一张在选/在上传，就继续等——多图里漏一张，模型就少看一张
    const pending = list.some(
      (a) =>
        a.status === Attach.ATTACH.UPLOADING || a.status === Attach.ATTACH.PICKED,
    );
    if (!pending) return list.map((a) => a.id).filter(Boolean);
    await new Promise((r) => setTimeout(r, 150));
  }
  return attaches.value.map((a) => a.id).filter(Boolean);
}

/**
 * 分析失败重试：复用同一 requestId + 同一张图，服务端按同一轮重跑。
 * 这样历史里不会出现同一个问题两条记录。
 */
async function analyzeAgain() {
  analyzeAgainAt(0);
}

async function analyzeAgainAt(index) {
  const a = attaches.value[index];
  if (!a || !Attach.canRetryAnalysis(a)) return;
  const text = voiceText.value || lastQuestionText;
  if (!text) return;
  voiceError.value = "";
  voiceRequestId = a.requestId || newVoiceRequestId();
  await askStreaming(text, voiceEpoch, { retry: true });
}

// 招呼、试麦、听不清的零碎字：这类话没有可回答的内容。
// 直接丢给模型，它只能套用"无法确认"的三段式，用户会以为系统坏了；
// 而且每一句"喂喂喂"都会在会话列表里留下一条空记录。
//
// 但拦截必须"整句就是招呼"才算，不能按字数猜。
// 老逻辑是"12 字以内 + 以招呼词开头"就拦，结果「你好，叶子黄了怎么办」
// 去掉标点正好 10 字，被当成招呼回「您好，我在」——用户以为 AI 听不懂人话。
// 现在的规则：先剥掉招呼词，剥完还有字就说明带实义，一律进模型。
const GREET_TOKENS = [
  "你好", "您好", "哈喽", "hello", "hi", "喂",
  "在吗", "在不在", "听得到吗", "能听到吗", "能听见吗",
  "听得到", "能听到", "能听见",
  // 长词必须排在短词前面：stripTokens 按顺序试，先命中"连接正常"
  // 会剩下一个"吗"，整句就判不出是招呼了
  "连接正常吗", "连接正常",
  "测试一下", "测试", "试一下", "试试", "嗯", "哦", "啊",
];
const ACK_TOKENS = [
  "谢谢", "多谢", "感谢", "辛苦了", "麻烦你了",
  "收到", "明白", "懂了", "好嘞", "好的", "行", "ok",
];
// 只要句子里有这些词，就不是招呼，是问题。这条是硬闸门：
// 宁可把招呼漏给模型（它会礼貌回应），也不能把问题当招呼吃掉。
const REAL_QUESTION =
  /(怎么办|怎么治|怎么弄|怎么用|什么|为什么|为啥|为啥子|多少|几个|哪些|哪里|哪个|是不是|能不能|会不会|要不要|有没有|咋|如何|谁|几时|什么时候)/;

function stripTokens(s, list) {
  let rest = s;
  let changed = true;
  while (changed && rest) {
    changed = false;
    for (const tok of list) {
      if (rest.startsWith(tok)) {
        rest = rest.slice(tok.length);
        changed = true;
      }
    }
  }
  return rest;
}

function chitChatReply(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "我在，您说。";
  // 去标点、去语气词、统一小写，方便按"词"判断而不是按"字"数
  const t = raw
    .replace(/[\s，。！？、,.!?~…·；;：:]/g, "")
    .replace(/[呀呢嘛吧啦哦哈]+$/g, "")
    .toLowerCase();
  if (!t) return "我在，您说。";
  if (REAL_QUESTION.test(t)) return ""; // 带实义，交给模型
  if (t.length > 10) return ""; // 长句不可能是纯招呼
  if (/^(.)\1+$/.test(t)) return "我在，您说。"; // 复读：喂喂喂、为为为
  if (!stripTokens(t, ACK_TOKENS)) return "好，还有问题随时说。";
  if (stripTokens(t, GREET_TOKENS) === "") {
    if (/测试|试一下|试试/.test(t)) return "通话正常，我在听，您说。";
    if (/听得到|听到吗|能听见|能听到/.test(t)) return "听得到，您说。";
    return "您好，我在。您直接说问题就行。";
  }
  return "";
}

async function askStreaming(text, epoch = voiceEpoch, opts = {}) {
  // 招呼先在这一层拦掉：不进模型、不建轮次，只回一句并继续听
  const greet = chitChatReply(text);
  if (greet && opts.retry !== true) {
    // 招呼也可能在上一句还没播完时到来：先静音，否则两句叠在一起
    stopPlaybackNow();
    voiceText.value = text;
    voiceAnswerText.value = greet;
    voiceError.value = "";
    voicePhase.value = "";
    voiceInterrupted = false;
    voiceSpeaking = false;
    voiceStreamDone = true;
    lastTurnFailed = false;
    voiceState.value = "speaking";
    enqueueSpeech(greet);
    return;
  }
  voiceSpoken = false;
  const rid = voiceRequestId || newVoiceRequestId();
  voiceRequestId = rid; // 记下这一轮的编号：失败重试要复用它才不会多建一轮
  // 本轮带不带图：只有拿到服务端 image_id 才能带。
  // 还在传就等它传完（不再 4 秒就丢图）；传失败就停住，让用户重试或明确只发文字。
  // 本轮带哪些图：只有拿到服务端 image_id 的才算数，顺序就是用户选图的顺序。
  // 有一张没传完就等全部传完（不再 4 秒丢图）；有任何一张失败就停住，
  // 让用户重试或明确只发文字——绝不静默只发前几张。
  let imageIds = [];
  const textOnly = opts.textOnly === true;
  if (!textOnly && attaches.value.length) {
    const needWait = attaches.value.some(
      (a) =>
        a.status === Attach.ATTACH.UPLOADING || a.status === Attach.ATTACH.PICKED,
    );
    if (needWait) {
      voiceState.value = "thinking";
      voicePhase.value = "uploading";
    }
    imageIds = await waitAttachSettled();
    // 等图期间用户挂断/取消/又问了新的 → 这一轮作废，不悄悄发出去
    if (epoch !== voiceEpoch) return;
    const want = attaches.value.length;
    if (imageIds.length < want) {
      voicePhase.value = "";
      voiceState.value = "idle";
      lastTurnFailed = false;
      const missing = attaches.value.filter((a) => !a.id);
      voiceError.value = missing.some((a) => a.status === Attach.ATTACH.FAILED)
        ? `${missing.length} 张图没传上去：点「重试」再传，或者删掉这几张只发文字`
        : missing.some((a) => a.status === Attach.ATTACH.UPLOADING)
          ? "图片还在传，传好后会自动继续；也可以删掉只发文字"
          : "有图片已失效，请重新拍一张";
      return; // 关键：不发残缺的图
    }
    if (needWait) voicePhase.value = "queued";
  }
  // 用户嘴上说"发张图/拍张照"但还没选图：先让他去拍照。
  // 这句话要是当普通问题发出去，模型会顺着"看图"的语境编内容——那就是假装看到了。
  // 只在短句里判定，避免"我上次拍的照片怎么防治"这类正常长问题被误拦。
  const wantsImage =
    !imageIds.length && !attaches.value.length && text.length <= 20 &&
    /(发|传|拍|看|瞧).{0,4}(图|照片|照)/.test(text);
  if (wantsImage) {
    voiceError.value =
      attach.value.status === Attach.ATTACH.FAILED
        ? "这张图没传成功，先重试上传或重新拍一张"
        : "还没选图片。点拍照或相册选一张，选好再问一次";
    voiceState.value = "idle";
    lastTurnFailed = false;
    return;
  }
  const retry = opts.retry === true;
  let finalStatus = "";
  lastQuestionText = text;
  // 上一句可能还在响（用户在播报中又问了新的）：先彻底静音再开始这一轮
  stopPlaybackNow();
  voiceState.value = "thinking";
  voicePhase.value = "queued";
  voiceAnswerText.value = "";
  voiceTtsWarn.value = false;
  voiceQueue = [];
  voiceSpeaking = false;
  voiceStreamDone = false;
  voiceInterrupted = false;
  const ac = new AbortController();
  voiceAbort = ac;
  let full = "";
  let pending = "";
  // 首字超时：到点还没有任何输出就放弃。否则上游卡住时界面会一直"正在思考"，
  // 用户分不清是慢还是死了。用独立标志区分"用户打断"和"模型没响应"。
  let firstCharTimedOut = false;
  const t0 = performance.now();
  let firstCharTimer = window.setTimeout(() => {
    if (!full) {
      firstCharTimedOut = true;
      try {
        ac.abort();
      } catch (e) {}
    }
  }, VOICE_FIRST_TOKEN_MS);
  const clearFirstChar = () => {
    if (firstCharTimer) {
      window.clearTimeout(firstCharTimer);
      firstCharTimer = 0;
    }
  };
  voiceTiming = {
    t0,
    firstCharMs: 0,
    ttsReqMs: 0,
    ttsGotMs: 0,
    firstAudioMs: 0,
    asrMs: voiceTiming.asrMs || 0,
  };
  // 识别这半秒正好用来把播放器叫醒，等到该出声时不用再等设备
  warmUpSpeaker();
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
        // 附了照片：只带编号（图片本身已在 /voice/image 落盘），
        // image_ids 按用户选图顺序，模型看到的顺序就是这个顺序
        image_id: imageIds[0] || undefined,
        image_ids: imageIds.length ? imageIds : undefined,
        // 失败重试：服务端按同一 request_id 重跑同一轮，不新建问题
        retry: retry || undefined,
      }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "服务返回 " + res.status);
    }
    // 图已随本轮提交 → 分析中。id 保留在状态里，追问时还能继续用同一张。
    // 若这张图上一轮已经分析完成（DONE），追问时保持完成态：
    // 服务端确实会再读一次图给模型看，但界面上没必要再闪一次「正在看这张图」。
    for (const a of attaches.value) {
      if (!imageIds.includes(a.id) || a.status === Attach.ATTACH.DONE) continue;
      setAttachAt(
        attachIndexOf(a.dedupKey),
        Attach.beginAnalysis(a, {
          requestId: rid,
          conversationId: voiceConversationId,
        }),
      );
    }
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
          if (obj.conversation_id) {
            voiceConversationId = obj.conversation_id;
            // 语音里开的新会话也要让文字界面认下来，否则挂断后看着像对话丢了
            if (!conversationId.value) {
              conversationId.value = voiceConversationId;
              // 纯语音（不带图）也必须出现在历史会话里：
              // 会话已由服务端写入，这里补一次列表刷新，别让它只存在于数据库
              refresh().catch(() => {});
            }
          }
          if (obj.turn_id) {
            voiceTurnId = obj.turn_id;
            for (const a of attaches.value) {
              if (a.status !== Attach.ATTACH.ANALYZING) continue;
              setAttachAt(
                attachIndexOf(a.dedupKey),
                Attach.beginAnalysis(a, {
                  requestId: rid,
                  turnId: obj.turn_id,
                  conversationId: voiceConversationId,
                }),
              );
            }
          }
          // 服务端确认这一轮绑了哪张附件：界面显示"本轮引用"只用这个来源
          if (obj.image_attachment_id !== undefined)
            turnRefId.value = obj.image_attachment_id || "";
          continue;
        }
        if (obj.type === "phase") {
          voicePhase.value = obj.phase;
          if (obj.role) voiceLastRole = obj.role;
          if (obj.image_attachment_id !== undefined)
            turnRefId.value = obj.image_attachment_id || "";
          continue;
        }
        if (obj.error) throw new Error(obj.error);
        if (obj.delta) {
          // 打断之后迟到的旧答案是"隔轮串音"的来源，一律丢弃
          if (voiceInterrupted || ac.signal.aborted || epoch !== voiceEpoch) continue;
          if (!voiceTiming.firstCharMs) {
            voiceTiming.firstCharMs = Math.round(performance.now() - voiceTiming.t0);
            clearFirstChar(); // 已经有字了，不再判首字超时
          }
          full += obj.delta;
          pending += obj.delta;
          voiceAnswerText.value = full;
          // 切口取「第一个让长度够阈值的句末标点」，而不是第一个标点。
          // 只取第一个标点会切出很短的句子，塞回队首又永远长不大（每轮都从同一个短句开始），
          // 结果是整段憋到流结束才合成，首音反而更慢。
          while (true) {
            const firstCut = !voiceSpoken;
            const minLen = firstCut ? VOICE_FIRST_SENTENCE : VOICE_MIN_SENTENCE;
            const sentRe = firstCut ? VOICE_FIRST_SENT_RE : VOICE_SENT_RE;
            if (pending.length < minLen) break;
            sentRe.lastIndex = 0;
            let pos = -1;
            let mm;
            while ((mm = sentRe.exec(pending))) {
              if (mm.index + 1 >= minLen) {
                pos = mm.index + 1;
                break;
              }
            }
            if (pos < 0) break;
            const cut = pending.slice(0, pos).trim();
            pending = pending.slice(pos);
            if (cut) enqueueSpeech(cut);
          }
        }
        if (obj.done) {
          finalStatus = obj.status || "completed";
          voicePhase.value = finalStatus;
        }
      }
    }
    if (voiceInterrupted || epoch !== voiceEpoch) return;
    if (pending.trim()) enqueueSpeech(pending.trim());
    // 这一轮收尾：只有正常结束才算「这张图分析完成」
    if (imageIds.length) {
      // 已经分析过的图，本轮生成失败是「这一问没答出来」，不是「图有问题」
      const stillAnalyzing = attaches.value.some(
        (a) => a.status === Attach.ATTACH.ANALYZING,
      );
      if (finalStatus === "failed" && stillAnalyzing) {
        markAllAttaches((a) => Attach.analysisFail(a, "模型没有返回内容"));
        lastTurnFailed = true;
      } else {
        markAllAttaches((a) => Attach.analysisOk(a));
        lastTurnFailed = finalStatus === "failed";
      }
    } else {
      lastTurnFailed = finalStatus === "failed";
    }
    voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: full });
    voiceHistory = voiceHistory.slice(-8);
    voiceStreamDone = true;
    refresh().catch(() => {});
    if (!voiceSpeaking && voiceQueue.length === 0) resumeListening();
  } catch (e) {
    // 首字超时是"模型没响应"，和用户主动打断要分开：
    // 前者要给可重试的失败提示，后者是正常操作、不该报错。
    if (firstCharTimedOut) {
      const why = `模型 ${Math.round(VOICE_FIRST_TOKEN_MS / 1000)} 秒没有响应，可以重试`;
      voiceError.value = why;
      if (imageIds.length) markAllAttaches((a) => Attach.analysisFail(a, why));
      lastTurnFailed = true;
      voiceState.value = "failed";
      voiceStreamDone = true;
      return;
    }
    if (voiceInterrupted || ac.signal.aborted) {
      // 用户主动打断/取消：不是失败，图还是好的，退回「服务器已收到」
      markAllAttaches((a) => Attach.analysisCanceled(a));
      lastTurnFailed = false;
      return;
    }
    voiceError.value = friendlyError(e, "生成失败");
    reportIfScriptError(e);
    if (imageIds.length)
      markAllAttaches((a) => Attach.analysisFail(a, friendlyError(e, "生成失败")));
    lastTurnFailed = true;
    voiceState.value = "failed";
    voiceStreamDone = true;
  } finally {
    clearFirstChar();
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
  stopBargeIn(); // 先收回打断监听，再停播，避免监听器把停播当成"又开口"
  playbackEpoch += 1; // 旧播放链据此退出
  stopAllAudio();
  if (voiceSpeakResolve) {
    const fn = voiceSpeakResolve;
    voiceSpeakResolve = null;
    try {
      fn();
    } catch (e) {}
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (e) {}
  try {
    const n = voiceNative();
    if (n && typeof n.stopSpeaking === "function") n.stopSpeaking();
    if (n && typeof n.stopListening === "function") n.stopListening();
  } catch (e) {}
  voiceQueue = [];
  clearTtsPrefetch();
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

// 到上限转成的文字：用户点确认才发
function confirmVoiceSend() {
  if (!voiceText.value) return;
  voiceConfirmPending.value = false;
  voiceError.value = "";
  lastTurnFailed = false; // 这是一次全新的提问，不是重试失败轮次
  voiceRequestId = newVoiceRequestId();
  askStreaming(voiceText.value, voiceEpoch);
}

function discardVoiceSend() {
  voiceConfirmPending.value = false;
  voiceError.value = "";
  voiceText.value = "";
  voiceState.value = "idle";
}

// 重试回答：换新请求编号重开一轮（失败轮次留在历史里，便于定位）
function retryAnswer(opts = {}) {
  if (!voiceText.value) return;
  voiceError.value = "";
  // 上一轮失败就复用同一 request_id（服务端按同一轮重跑，不新建问题）；
  // 只有确实要换一轮时才申请新编号
  const sameTurn = lastTurnFailed && Boolean(voiceRequestId);
  if (!sameTurn) voiceRequestId = newVoiceRequestId();
  askStreaming(voiceText.value, voiceEpoch, { ...opts, retry: sameTurn });
}

// 图传不上去时，给用户一条明确出路：不带图问，而不是卡在那里
function retryAnswerTextOnly() {
  dropAttach();
  retryAnswer({ textOnly: true });
}

// 把所有正在播放的音频一次掐掉，并让它们的 Promise 正常收尾，
// 否则旧链会一直 await 在那里，下次播报就变成两条声音并行。
function stopAllAudio() {
  const items = Array.from(liveAudios.entries());
  liveAudios.clear();
  for (const [audio, resolve] of items) {
    try {
      audio.onended = null;
      audio.onpause = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
    } catch (e) {}
    try {
      resolve();
    } catch (e) {}
  }
  voiceAudio = null;
}

/** 新一轮开口前先彻底静音：清队列、作废预取、掐音频、停原生朗读 */
function stopPlaybackNow() {
  playbackEpoch += 1; // 旧播放链据此退出
  voiceQueue = [];
  clearTtsPrefetch();
  stopAllAudio();
  if (voiceSpeakResolve) {
    const fn = voiceSpeakResolve;
    voiceSpeakResolve = null;
    try {
      fn();
    } catch (e) {}
  }
  if (voicePreviewAudio) {
    try {
      voicePreviewAudio.pause();
    } catch (e) {}
    voicePreviewAudio = null;
  }
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (e) {}
  try {
    const n = voiceNative();
    if (n && typeof n.stopSpeaking === "function") n.stopSpeaking();
  } catch (e) {}
  voiceSpeaking = false;
}

function enqueueSpeech(text) {
  const t = stripForSpeech(text);
  if (!t) return;
  voiceSpoken = true;
  voiceQueue.push(t);
  if (!voiceSpeaking) playNext();
  // 当前句还在播：这句就是下一句，先送合成，播完立刻能接上
  else prefetchTts(t);
}

async function playNext() {
  const epoch = playbackEpoch;
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
  // 当前句已经定了：队列里的下一句先送合成（流式刚到时它还没被预取）
  prefetchTts(voiceQueue[0]);
  let ok = false;
  if (voiceServer.tts) {
    try {
      await playServerTts(text);
      ok = true;
    } catch (e) {
      ok = false;
    }
  }
  // 这一句播完之前已经被新一轮顶掉：到此为止，绝不能再往下播
  if (epoch !== playbackEpoch) return;
  // 被打断时不要再用本机嗓门补念一句
  if (!ok && !voiceInterrupted) {
    let hasNative = false;
    try {
      const n = voiceNative();
      hasNative = Boolean((n && typeof n.speak === "function") || window.speechSynthesis);
    } catch (e) {}
    if (!hasNative) voiceTtsWarn.value = true; // 两条路都没声音，必须让用户看见
    try {
      await playFallbackTts(text);
    } catch (e) {}
  }
  if (epoch !== playbackEpoch) return;
  voiceSpeaking = false;
  playNext();
}

// 所有合成请求的唯一出口：预取和即时请求走同一条路，音色/超时口径一致
function ttsFetch(text, ac) {
  return fetch("/api/v2/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workbench": "1" },
    // 本地合成不分音色，传了也只会让缓存分成几份、白占空间
    body: JSON.stringify({ text, voice: isLocalTts() ? "" : voiceName.value || "" }),
    signal: ac.signal,
  }).then((r) => {
    if (!r.ok) throw new Error("TTS " + r.status);
    return r.blob();
  });
}

// 预取：当前句还在播的时候，把后面的句子先合成好
function prefetchTts(text) {
  const t = String(text || "").trim();
  if (!t || !voiceServer.tts || voiceInterrupted) return;
  if (ttsPrefetch.has(t) || ttsPrefetch.size >= TTS_PREFETCH_AHEAD) return;
  const ac = new AbortController();
  const timer = window.setTimeout(() => {
    try {
      ac.abort();
    } catch (e) {}
  }, VOICE_TTS_MS);
  const promise = ttsFetch(t, ac).finally(() => window.clearTimeout(timer));
  promise.catch(() => {}); // 预取失败不冒泡成未处理拒绝，播放时会重新请求
  ttsPrefetch.set(t, { promise, ac });
}

// 停止播报/打断时作废在途预取，别继续占着合成服务
function clearTtsPrefetch() {
  for (const item of ttsPrefetch.values()) {
    try {
      item.ac.abort();
    } catch (e) {}
  }
  ttsPrefetch.clear();
  for (const ac of ttsInflight) {
    try {
      ac.abort();
    } catch (e) {}
  }
  ttsInflight.clear();
}

// 取音频：命中预取就直接用，没命中才现请求
function loadTtsBlob(text) {
  const hit = ttsPrefetch.get(text);
  if (hit) {
    ttsPrefetch.delete(text);
    return hit.promise.catch(() =>
      // 预取被打断/超时：换一次即时合成，别让这句话没声音
      requestTts(text),
    );
  }
  return requestTts(text);
}

// ── 音频通路预热 ──
// WebView 里第一次 new Audio(...).play() 要等系统把音频输出拉起来（蓝牙耳机更慢），
// 实测常吃掉 0.5~1 秒。说话时先放一段数字静音（全 0 采样，听不见），
// 把这笔初始化提前到"上传识别"的那半秒里。
let warmAudioEl = null;
function silentWavDataUrl(ms) {
  const rate = 8000;
  const n = Math.max(1, Math.round((rate * (ms || 120)) / 1000));
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const ascii = (o, t) => {
    for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, "data");
  dv.setUint32(40, n * 2, true);
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(raw);
}

function warmUpSpeaker() {
  try {
    if (!warmAudioEl) {
      warmAudioEl = new Audio(silentWavDataUrl(120));
      warmAudioEl.preload = "auto";
    }
    try {
      warmAudioEl.currentTime = 0;
    } catch (e) {}
    const p = warmAudioEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

// 即时的单句合成请求：登记在册，打断时一起作废
function requestTts(text) {
  // 首句的合成请求发出时刻：和首音对比就能把「合成+下载」与「解码出声」分开
  if (voiceTiming.t0 && !voiceTiming.ttsReqMs)
    voiceTiming.ttsReqMs = Math.round(performance.now() - voiceTiming.t0);
  const ac = withTtsTimeout(new AbortController());
  ttsInflight.add(ac);
  const done = () => ttsInflight.delete(ac);
  return ttsFetch(text, ac).then(
    (b) => {
      done();
      return b;
    },
    (e) => {
      done();
      throw e;
    },
  );
}

// 超时就放弃服务端合成，交给本机朗读兜底
function withTtsTimeout(ac) {
  const timer = window.setTimeout(() => {
    try {
      ac.abort();
    } catch (e) {}
  }, VOICE_TTS_MS);
  ac.signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
  return ac;
}

function playTtsBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    // 语速在这里生效：以前只存了 localStorage，播放时从没读过，选 1.3× 也没变化
    try {
      audio.playbackRate = voiceRate.value || 1;
      audio.preservesPitch = true;
      if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
    } catch (e) {}
    voiceAudio = audio;
    liveAudios.set(audio, resolve);
    const release = () => {
      liveAudios.delete(audio);
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
      if (voiceAudio === audio) voiceAudio = null;
    };
    // 首段声音真正播出来的时刻：用户"听到回答"的延迟，
    // 与首字耗时不是一回事（中间还有合成与解码）
    audio.onplaying = () => {
      if (!voiceTiming.firstAudioMs)
        voiceTiming.firstAudioMs = Math.round(performance.now() - voiceTiming.t0);
    };
    audio.onended = () => {
      release();
      resolve();
    };
    audio.onerror = () => {
      release();
      reject(Error("播放失败"));
    };
    // 打断时 pause() 不会触发 onended，这里兜底结束当前句
    audio.onpause = () => {
      release();
      resolve();
    };
    audio.play().catch((e) => {
      URL.revokeObjectURL(url);
      voiceAudio = null;
      reject(e);
    });
  });
}

async function playServerTts(text) {
  const blob = await loadTtsBlob(text);
  if (voiceTiming.t0 && !voiceTiming.ttsGotMs)
    voiceTiming.ttsGotMs = Math.round(performance.now() - voiceTiming.t0);
  await playTtsBlob(blob);
}

function playFallbackTts(text) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = 0;
    // 只解一次：正常靠 speakEnd / onend，异常靠超时，重复调用无副作用
    const settle = () => {
      if (settled) return;
      settled = true;
      if (guard) window.clearTimeout(guard);
      if (voiceSpeakResolve === settle) voiceSpeakResolve = null;
      resolve();
    };
    const n = voiceNative();
    if (n && typeof n.speak === "function") {
      voiceSpeakResolve = settle;
      // 壳没回 speakEnd（引擎缺失、老版本、被系统杀掉）时不能一直等，
      // 否则 voiceSpeaking 卡在 true，后续句子不再播、界面也不会回到收听。
      guard = window.setTimeout(settle, 15000);
      try {
        n.speak(text);
      } catch (e) {
        settle();
      }
      return;
    }
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.onend = settle;
      u.onerror = settle;
      guard = window.setTimeout(settle, 15000);
      window.speechSynthesis.speak(u);
      return;
    }
    settle();
  });
}

function resumeListening() {
  stopBargeIn(); // 播报结束，收回打断监听，避免和接下来的录音抢麦克风
  // 一轮真正走完（生成结束且播报结束）时落一行耗时。
  // 真机上打开控制台就能看出卡在哪一段，不用再靠"感觉有点慢"。
  if (voiceTiming.t0 && !voiceTiming.logged) {
    voiceTiming.logged = true;
    const totalMs = Math.round(performance.now() - voiceTiming.t0);
    try {
      console.info(
        "[voice] 识别 " + voiceTiming.asrMs + "ms · 首字 " + voiceTiming.firstCharMs +
          "ms · 送合成 " + voiceTiming.ttsReqMs + "ms · 音频到手 " + voiceTiming.ttsGotMs +
          "ms · 出声 " + voiceTiming.firstAudioMs + "ms · 完整 " +
          totalMs + "ms · 角色 " + (voiceLastRole || "?"),
      );
    } catch (e) {}
    // 手机上看不到 console，同一份打点再发一份到服务端日志，
    // 这样"感觉慢了"能变成"哪一段慢"
    try {
      fetch("/api/v2/voice/timing", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Workbench": "1" },
        body: JSON.stringify({
          asrMs: voiceTiming.asrMs,
          firstCharMs: voiceTiming.firstCharMs,
          ttsReqMs: voiceTiming.ttsReqMs,
          ttsGotMs: voiceTiming.ttsGotMs,
          firstAudioMs: voiceTiming.firstAudioMs,
          totalMs: totalMs,
          role: voiceLastRole || "",
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }
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
  // 迟到回调防护：不是本次录音的会话，一律丢掉。
  // 场景是真实存在的——上滑取消后，早已开始的 MediaRecorder 仍会回传 audio；
  // 过去这里直接 uploadAudio，等于替用户把取消掉的话发了出去。
  if (ev.session && recSessionId && ev.session !== recSessionId) return;
  if (ev.type === "audio") {
    if (recSubmitted) return; // 一次录音只认一份结果
    if (voiceHoldAbort) return; // 已取消/切后台中断
    recSubmitted = true;
    uploadAudio(base64ToBlob(ev.data || "", ev.ext || "m4a"), ev.ext || "m4a", {
      confirmOnly: recConfirmOnly,
    });
    return;
  }
  if (ev.type === "limit") {
      stopHoldTimer();
      voiceHolding.value = false;
      voiceHoldAbort = true;
      voiceState.value = "idle";
    voiceError.value = ev.message || "录音时间过长，本次未发送";
    return;
  }
  if (ev.type === "partial") {
    voiceText.value = ev.text || "";
  } else if (ev.type === "result") {
    if (recSubmitted || voiceHoldAbort) return;
    recSubmitted = true;
    const text = String(ev.text || "").trim();
    voiceText.value = text;
    if (!text) return;
    if (recConfirmOnly) {
      voiceConfirmPending.value = true;
      voiceState.value = "idle";
      voiceError.value = "已到最长录音时间，内容已转成文字，确认无误再发送";
      return;
    }
    askStreaming(text);
  } else if (ev.type === "error") {
    const msg = ev.message || "语音识别失败";
    // 本机朗读只是服务端合成失败后的兜底：引擎缺失不该红字打断对话，
    // 更不能让 voiceSpeakResolve 一直挂着，否则播放链永远不往下走。
    if (msg.indexOf("朗读") >= 0) {
      if (voiceSpeakResolve) {
        const fn = voiceSpeakResolve;
        voiceSpeakResolve = null;
        fn();
      }
      return;
    }
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
  clearTtsPrefetch();
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

function toggleCaption() {
  voiceCaptionOn.value = !voiceCaptionOn.value;
}

function endCall() {
  unbindHoldPointer();
  document.removeEventListener("visibilitychange", onVoiceVisibility);
  window.removeEventListener("blur", onVoiceBlur);
  voiceHolding.value = false;
  voiceHoldMs.value = 0;
  voiceMode.value = false;
  stopVoiceClock();
  voiceState.value = "idle";
  voiceSetupOpen.value = false;
  voiceQueue = [];
  clearTtsPrefetch();
  voiceSpeaking = false;
  stopBargeIn(); // 退出通话必须收回打断监听，否则麦克风会一直开着
  cleanupCapture();
  closeCamera();
  disposeShot();
  dropAttach();
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
  // 挂断后把这一通电话的轮次拉到界面上：语音轮次是边聊边落库的，
  // 但挂断前没有再拉过一次，用户回来只看到挂断前的旧内容。
  // 另外，若这一通电话是在"没有会话"的状态下开的，会话是由服务端建的，
  // 这里补上选中，避免挂断后停在空白页、看着像对话没保存。
  if (!conversationId.value && voiceConversationId)
    conversationId.value = voiceConversationId;
  refreshCurrent().catch(() => {});
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

// 启动探测：短超时 + 明确失败态。以前这里没有独立超时，链路挂住就白屏 60 秒。
async function boot() {
  bootState.value = "loading";
  bootError.value = "";
  error.value = "";
  try {
    const status = await call("/auth/status", undefined, undefined, {
      timeoutMs: TIMEOUTS.boot,
    });
    setup.value = status.setup_required;
    user.value = status.user;
    if (user.value) {
      await loadDepartments();
      await refresh();
    }
    ready.value = true;
    bootState.value = "ready";
  } catch (e) {
    bootError.value = friendlyError(e);
    bootState.value = "failed";
    ready.value = false;
    reportIfScriptError(e);
  }
}
// 切回前台立刻补一拍，别等退避计时器
function onVisibility() {
  if (!document.hidden) poller.tick();
}
onMounted(async () => {
  // 接收安卓壳的语音事件
  window.__qingheVoice = handleVoiceEvent;
  document.addEventListener("click", closeDeptMenu);
  document.addEventListener("visibilitychange", onVisibility);
  await boot();
  await loadActiveTurns();
  poller.start();
  clock = setInterval(() => (nowTick.value = Date.now()), 1000);
});
onUnmounted(() => {
  disposed = true;
  poller.stop();
  clearInterval(clock);
  document.removeEventListener("visibilitychange", onVisibility);
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
        {{
          bootState === "loading"
            ? "连接工作台…"
            : bootState === "failed"
              ? "连不上工作台"
              : setup
                ? "创建管理员账号"
                : "欢迎回来"
        }}
      </h1>
      <div
        v-if="bootState === 'failed'"
        style="display: flex; flex-direction: column; gap: 10px; margin-top: 14px"
      >
        <p class="subtle" style="margin: 0">
          {{ bootError || "网络暂时不通，检查一下网络再试" }}
        </p>
        <button class="primary" type="button" @click="boot">重试连接</button>
      </div>
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
          <div class="chat-bar">
            <button
              type="button"
              class="outline chat-bar-btn"
              @click="convDrawer = true"
            >
              <History :size="16" /><span>历史会话</span>
              <em v-if="conversations.length">{{ conversations.length }}</em>
            </button>
            <button
              type="button"
              class="primary chat-bar-btn"
              @click="newConversation"
            >
              <Plus :size="16" /><span>新会话</span>
            </button>
          </div>
          <!-- 后台任务：切走会话以后，上一会话还在跑的那条不该消失。
               没有这一条时只能靠记忆翻历史去猜它停没停。 -->
          <div v-if="backgroundTurns.length" class="bg-tasks" role="status">
            <span class="bg-tasks-label"
              >还有 {{ backgroundTurns.length }} 条在别的会话里生成</span
            >
            <ul>
              <li v-for="bt in backgroundTurns" :key="bt.id">
                <button
                  type="button"
                  class="bg-open"
                  @click="openBackgroundTurn(bt)"
                >
                  {{ bt.question || "（语音提问）" }}
                </button>
                <span v-if="bt.cancel_requested_at" class="bg-pending"
                  >停止中…</span
                >
                <button
                  v-else
                  type="button"
                  class="text-button stop"
                  :disabled="cancelingTurnId === bt.id"
                  @click="cancelTurn(bt)"
                >
                  {{ cancelingTurnId === bt.id ? "停止中…" : "停止" }}
                </button>
              </li>
            </ul>
          </div>
          <div class="chat-layout">
            <div class="conversation-body">
              <section v-if="!turns.length" class="panel welcome">
                <Sprout :size="36" />
                <h2>今天有什么农业问题？</h2>
                <p>
                  描述作物、生育期、现场环境和你的目标，能帮助模型给出更合适的建议。
                </p>
              </section>
              <!-- data-turn-id：后台任务/停止按钮要能按轮次精确定位，
                   免得"点最后一条的停止"误停前面那条还在生成的 -->
              <article
                v-for="t in turns"
                :key="t.id"
                class="turn"
                :data-turn-id="t.id"
              >
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
                    :disabled="cancelingTurnId === t.id"
                    @click="cancelTurn(t)"
                  >
                    {{ cancelingTurnId === t.id ? "停止中…" : "停止" }}
                  </button>
                  <p>
                    <span v-if="t.source === 'voice'" class="badge amber"
                      >语音</span
                    >{{ t.question }}
                  </p>
                  <!-- 随问附图：历史里也要看得见，否则回看时不知道当时给模型看的是什么。
                       多张时按上传顺序编号，追问沿用哪几张一眼能对上。 -->
                  <div v-if="turnImageIds(t).length" class="turn-shots">
                    <button
                      v-for="(iid, ii) in turnImageIds(t)"
                      :key="iid"
                      type="button"
                      class="turn-shot"
                      title="查看原图"
                      @click="zoomShot(iid)"
                    >
                      <img
                        :src="'/api/v2/voice/image/' + iid"
                        alt="随问附图"
                        loading="lazy"
                      />
                      <span>{{
                        turnImageIds(t).length > 1 ? "第 " + (ii + 1) + " 张" : "随问附图"
                      }}</span>
                    </button>
                  </div>
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
                <p v-if="shotBusy" class="composer-shot-tip">
                  {{ shotBusyText || "正在处理照片…" }}
                </p>
                <!-- 本轮附图：按选择顺序排列，每张独立状态，可逐张删除/重试 -->
                <p v-if="attaches.length > 1 && attachCanSend" class="composer-shot-tip">
                  本轮带 {{ attaches.length }} 张图，会按你选的顺序一起发给模型
                </p>
                <div v-if="attaches.length" class="composer-shots">
                  <div
                    v-for="(a, ai) in attaches"
                    :key="a.dedupKey || ai"
                    class="composer-shot"
                    :class="attachToneOf(a)"
                  >
                    <img
                      :src="a.url"
                      alt="本轮附图"
                      title="点一下放大看"
                      @click="shotZoom = a.url"
                    />
                    <div class="composer-shot-side">
                      <b>第 {{ ai + 1 }} 张 · {{ attachInfoOf(a).text }}</b>
                      <span v-if="attachSubTextOf(a)">{{ attachSubTextOf(a) }}</span>
                      <p v-if="a.error" class="composer-shot-err">{{ a.error }}</p>
                      <div class="composer-shot-acts">
                        <button
                          v-if="a.status === 'failed'"
                          type="button"
                          class="composer-shot-act"
                          @click="retryAttachAt(ai)"
                        >
                          重试
                        </button>
                        <button
                          type="button"
                          class="composer-shot-x"
                          title="删除这张图"
                          @click="removeAttachAt(ai)"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <p v-if="voiceError" class="composer-shot-alert">{{ voiceError }}</p>
                <p v-if="sendPhase === 'unconfirmed'" class="composer-shot-alert">
                  上一条没收到服务器回执。
                  <button
                    type="button"
                    class="text-button"
                    @click="reconcileSend"
                  >
                    核对这一条
                  </button>
                  用的是同一个请求编号，不会重复生成
                </p>
                <div class="form-bottom">
                  <div class="composer-tools">
                    <span class="image-pick">
                      <button
                        type="button"
                        class="inline-check"
                        title="调用系统相机拍照，拍完可继续追加，最多 6 张"
                        @click="pickPhotoFile(true)"
                      >
                        <Camera :size="16" />拍照
                      </button>
                      <button
                        type="button"
                        class="inline-check"
                        title="从相册选图，可一次多选，最多 6 张"
                        @click="pickPhotoFile(false)"
                      >
                        <ImagePlus :size="16" />相册
                      </button>
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
                    @click="startCall"
                  >
                    <Mic :size="16" />语音通话
                  </button
                  ><button
                    class="primary"
                    :disabled="!question.trim() && sendPhase !== 'unconfirmed'"
                  >
                    {{ sendPhase === "unconfirmed" ? "核对上一条" : "发送问题" }}
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

              <section class="team-detail panel" :class="{ 'has-conv': !!teamConv }">
                <template v-if="teamConv">
                  <header class="team-detail-head">
                    <button
                      type="button"
                      class="team-back"
                      @click="teamConv = null"
                    >
                      <ChevronLeft :size="16" />返回列表
                    </button>
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

    <!-- 语音通话浮层：整屏沉浸式（对齐 10-26 那版 vc 布局） -->
    <div v-if="voiceMode" class="vc">
      <!-- 准备/授权引导：保留原有卡片 -->
      <div v-if="voiceSetupOpen" class="vc-setup">
        <div class="voice-orb is-idle"><Mic :size="30" /></div>
        <h2 class="voice-title">语音通话需要准备一下</h2>
        <ul class="voice-steps">
          <li v-for="(step, i) in voiceSetupSteps" :key="i">
            <template v-if="typeof step === 'string'">{{ step }}</template>
            <a v-else :href="step.href" target="_blank" rel="noreferrer">{{ step.text }}</a>
          </li>
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
      </div>

      <template v-else>
        <header class="vc-top">
          <button type="button" class="vc-icon" title="返回" @click="endCall">
            <ChevronLeft :size="20" />
          </button>
          <div class="vc-clock">
            <b>语音通话</b>
            <span>{{ voiceClockText }}</span>
          </div>
          <button
            type="button"
            class="vc-cap"
            :class="{ on: voiceCaptionOn }"
            :aria-pressed="voiceCaptionOn ? 'true' : 'false'"
            :title="voiceCaptionOn ? '字幕已开启，点击关闭' : '字幕已关闭，点击开启'"
            @click="toggleCaption"
          >
            <Captions v-if="voiceCaptionOn" :size="17" />
            <CaptionsOff v-else :size="17" />
            <span>{{ voiceCaptionOn ? '字幕开' : '字幕关' }}</span>
          </button>
        </header>

        <div class="vc-stage">
          <div
            class="vc-orb"
            :class="'is-' + voiceOrbState"
            :style="{ '--lv': voiceLevel }"
          >
            <i class="vc-halo h1"></i>
            <i class="vc-halo h2"></i>
            <i class="vc-halo h3"></i>
            <b class="vc-core"><Mic :size="30" /></b>
          </div>
          <h2 class="vc-state">{{ voiceStateText }}</h2>
          <p class="vc-hint">{{ voiceHintText }}</p>

          <div class="vc-caption">
            <p v-if="voiceCaptionOn && voiceText" class="vc-said">你说：{{ voiceText }}</p>
            <p v-if="voiceCaptionOn && voiceAnswerText" class="vc-say">
              {{ voiceAnswerText }}
            </p>

            <!-- 本轮附图：按选择顺序排列，每张独立状态；缩略图不等于已上传 -->
            <p v-if="attaches.length > 1 && attachCanSend" class="vc-shot-tip">
              本轮带 {{ attaches.length }} 张图，按你选的顺序交给模型；追问会继续用这几张
            </p>
            <div v-if="attaches.length" class="vc-shot-row">
              <div
                v-for="(a, ai) in attaches"
                :key="a.dedupKey || ai"
                class="vc-shot"
                :class="attachToneOf(a)"
              >
                <img
                  :src="a.url"
                  alt="本轮附图"
                  title="点一下放大看"
                  @click="shotZoom = a.url"
                />
                <div class="vc-shot-side">
                  <b class="vc-shot-label"
                    >第 {{ ai + 1 }} 张 · {{ attachInfoOf(a).text }}</b
                  >
                  <span v-if="attachSubTextOf(a)" class="vc-shot-sub">{{
                    attachSubTextOf(a)
                  }}</span>
                  <p v-if="a.error" class="vc-shot-err">{{ a.error }}</p>
                  <div class="vc-shot-acts">
                    <button
                      v-if="a.status === 'failed'"
                      type="button"
                      class="vc-shot-act"
                      @click="retryAttachAt(ai)"
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      class="vc-shot-x"
                      title="删除这张图"
                      @click="removeAttachAt(ai)"
                    >
                      <X :size="14" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <p v-if="voiceTtsWarn" class="vc-tts-warn">
              这段没能合成语音（服务端和本机朗读都没出声），文字已显示在上方
            </p>
            <p v-if="voiceError" class="vc-error">{{ voiceError }}</p>
            <div
              v-if="voiceConfirmPending && voiceText && voiceState === 'idle'"
              class="vc-retry-row"
            >
              <button type="button" class="vc-retry" @click="confirmVoiceSend">
                确认发送
              </button>
              <button type="button" class="vc-retry ghost" @click="discardVoiceSend">
                不用了
              </button>
            </div>
            <div
              v-if="voiceError && voiceText && voiceState === 'idle' && !voiceConfirmPending"
              class="vc-retry-row"
            >
              <button type="button" class="vc-retry" @click="retryAnswer()">
                重试回答
              </button>
              <button
                v-if="attach.url && !attachCanSend"
                type="button"
                class="vc-retry ghost"
                @click="retryAnswerTextOnly"
              >
                不带图，只发文字
              </button>
            </div>
          </div>
        </div>

        <footer class="vc-dock">
          <!-- 音色/语速收进一个入口，带当前值摘要，点开才是完整面板 -->
          <button
            type="button"
            class="vc-dock-set"
            @click="voiceSetOpen = true"
          >
            <SlidersHorizontal :size="14" />
            <span>音色 {{ voiceNameLabel }} · 语速 {{ voiceRateLabel }}</span>
            <ChevronUp :size="14" />
          </button>

          <!-- 主操作居中；次级「拍照」在左，破坏性「挂断」在右手拇指位（右侧） -->
          <div class="vc-dock-main">
            <button
              type="button"
              class="vc-round"
              :disabled="voiceState === 'recognizing'"
              title="拍照或从相册选图"
              @click="openCamSheet"
            >
              <Camera :size="22" /><span>拍照</span>
            </button>
            <button
              type="button"
              class="vc-talk"
              :class="{
                on: voiceHolding,
                busy: voiceState === 'thinking' || voiceState === 'speaking',
              }"
              :aria-label="holdLabel"
              @pointerdown.prevent="holdVoiceStart"
              @pointerup.prevent="holdVoiceEnd"
              @pointercancel.prevent="holdVoiceCancel"
              @pointermove="holdVoiceMove"
              @contextmenu.prevent
            >
              <Mic :size="34" />
              <em>{{ holdLabel }}</em>
            </button>
            <button
              type="button"
              class="vc-round danger"
              title="挂断"
              @click="endCall"
            >
              <PhoneOff :size="22" /><span>挂断</span>
            </button>
          </div>
        </footer>
      </template>

      <!-- 拍照链路等待：相机启动、回传、压缩期间都要有明确反馈 -->
      <div v-if="shotBusy" class="vc-wait">
        <i class="vc-wait-ring"></i>
        <p>{{ shotBusyText || "正在处理照片…" }}</p>
        <button type="button" class="vc-wait-cancel" @click="cancelShotWait">
          取消
        </button>
      </div>

      <!-- 页面内相机：实时取景 + 快门 -->
      <div v-if="voiceCamOpen" class="vc-cam">
        <video ref="voiceCamVideo" playsinline muted autoplay></video>
        <div class="vc-cam-top">
          <button type="button" class="vc-icon" title="关闭相机" @click="closeCamera">
            <X :size="20" />
          </button>
          <span>对准叶片，按中间白色快门</span>
        </div>
        <div class="vc-cam-bar">
          <button
            type="button"
            class="vc-shutter"
            :disabled="!voiceCamReady"
            @click="shootPhoto"
          >
            <i></i>
          </button>
        </div>
        <p v-if="voiceCamError" class="vc-cam-err">{{ voiceCamError }}</p>
      </div>

      <!-- 拍照/选图后的预览：先看清楚，再决定用这张、重拍还是取消 -->
      <div v-if="camShot && !voiceCamOpen" class="vc-cam vc-preview">
        <img :src="camShot.url" alt="待上传的照片预览" />
        <div class="vc-preview-tip">看清楚了吗？确认后才会传到服务器</div>
        <div class="vc-preview-bar">
          <button type="button" class="vc-preview-btn" @click="cancelShot">取消</button>
          <button type="button" class="vc-preview-btn primary" @click="confirmShot">
            用这张
          </button>
          <button type="button" class="vc-preview-btn" @click="retakeShot">重拍</button>
        </div>
      </div>

      <!-- 图片来源选择 -->
      <div
        v-if="voiceSheetOpen"
        class="vc-sheet-mask"
        @click.self="voiceSheetOpen = false"
      >
        <div class="vc-sheet">
          <button type="button" @click="useSystemCamera">
            <Camera :size="18" /><span>拍照</span>
          </button>
          <button type="button" @click="fromAlbum">
            <ImagePlus :size="18" /><span>从相册选择</span>
          </button>
          <button v-if="isSecurePage()" type="button" @click="openInPageCamera">
            <Camera :size="18" /><span>页面内取景（可连续拍）</span>
          </button>
          <p v-if="voiceCamError" class="err">{{ voiceCamError }}</p>
          <button type="button" class="cancel" @click="voiceSheetOpen = false">取消</button>
        </div>
      </div>

      <!-- 播报设置：谁在说话、说多快 -->
      <div
        v-if="voiceSetOpen"
        class="vc-sheet-mask"
        @click.self="voiceSetOpen = false"
      >
        <div class="vc-sheet vc-set">
          <div class="vc-set-head">
            <b>播报设置</b>
            <span>只影响回答的朗读，不影响识别</span>
          </div>

          <p class="vc-set-label">
            谁在说话（音色）
            <em v-if="isLocalTts()">本地合成目前只有这一个女声</em>
          </p>
          <div class="vc-set-chips">
            <button
              v-for="p in (isLocalTts() ? LOCAL_VOICE_PRESETS : VOICE_PRESETS)"
              :key="p.value || 'default'"
              type="button"
              class="vc-chip"
              :class="{ on: isLocalTts() || (voiceName || '') === p.value }"
              @click="pickVoice(p.value)"
            >
              <b>{{ p.label }}</b>
              <small>{{ p.note }}</small>
            </button>
          </div>

          <p class="vc-set-label">说多快（语速）</p>
          <div class="vc-set-chips">
            <button
              v-for="r in VOICE_RATES"
              :key="r.value"
              type="button"
              class="vc-chip rate"
              :class="{ on: voiceRate === r.value }"
              @click="pickRate(r.value)"
            >
              <b>{{ r.label }}</b>
              <small>{{ fmtRate(r.value) }}</small>
            </button>
          </div>

          <div class="vc-set-foot">
            <button
              type="button"
              class="vc-set-try"
              :disabled="voicePreviewing"
              @click="previewVoice"
            >
              {{ voicePreviewing ? "试听中…" : "试听" }}
            </button>
            <button type="button" class="vc-set-done" @click="voiceSetOpen = false">
              完成
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 原图查看：手机上点缩略图直接铺满，不跳浏览器 -->
    <div v-if="shotZoom" class="shot-zoom" @click.self="shotZoom = ''">
      <button type="button" class="shot-zoom-x" @click="shotZoom = ''">
        <X :size="20" />
      </button>
      <img :src="shotZoom" alt="随问附图原图" />
    </div>

    <!-- 历史会话：从左侧滑出的抽屉。原来是聊天区左边一栏常驻，
         手机上被压成 160px 高的滚动框，翻起来很别扭 -->
    <div
      class="conv-drawer-mask"
      :class="{ show: convDrawer }"
      @click="convDrawer = false"
    ></div>
    <aside
      class="conv-drawer"
      :class="{ open: convDrawer }"
      :aria-hidden="convDrawer ? 'false' : 'true'"
      aria-label="历史会话"
    >
      <header class="conv-drawer-head">
        <strong>历史会话</strong>
        <button
          type="button"
          class="conv-drawer-x"
          aria-label="关闭"
          @click="convDrawer = false"
        >
          <X :size="18" />
        </button>
      </header>
      <input
        v-model="convQuery"
        class="conv-drawer-search"
        type="search"
        placeholder="搜索会话"
        aria-label="搜索会话"
      />
      <button type="button" class="primary conv-drawer-new" @click="newConversation">
        <Plus :size="16" />新会话
      </button>
      <div class="conv-drawer-list">
        <template v-for="g in convGroups" :key="g.label">
          <p class="conv-group">{{ g.label }}</p>
          <div
            v-for="c in g.items"
            :key="c.id"
            :class="['conversation', { selected: c.id === conversationId }]"
          >
            <button class="conv-open" @click="selectConversation(c)">
              <strong>{{ c.title }}</strong>
              <small>{{ formatTime(c.created_at) }}</small>
            </button>
            <button
              class="conv-delete"
              :class="{ confirming: confirmingDelete === c.id }"
              :title="confirmingDelete === c.id ? '再次点击确认删除' : '删除会话'"
              @click.stop="deleteConversation(c)"
              >{{ confirmingDelete === c.id ? "确认" : "删除" }}</button
            >
          </div>
        </template>
        <p v-if="!convGroups.length" class="subtle conv-empty">
          {{ convQuery ? "没有匹配的会话" : "还没有会话，问一个问题就会自动保存" }}
        </p>
      </div>
    </aside>
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
  display: block;
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
.composer-shot-tip {
  margin: 8px 0 0;
  font-size: 12px;
  color: #4f6b57;
}
.composer-shots {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 0;
  max-height: 34vh;
  overflow: auto;
}
.composer-shot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 220px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f6f9f3;
  border: 1px solid #e4ecd9;
  text-align: left;
}
.composer-shot.ok {
  border-color: #78c9a4;
}
.composer-shot.bad {
  border-color: #f0a49c;
  background: #fdf3f1;
}
.composer-shot img {
  width: 56px;
  height: 56px;
  flex: none;
  border-radius: 8px;
  object-fit: cover;
  background: #e9efe6;
  border: 1px solid #dfe7e3;
}
.composer-shot-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.composer-shot-side b {
  font-size: 12px;
  font-weight: 600;
  color: #2c4a3a;
}
.composer-shot-side span {
  font-size: 11px;
  color: #718260;
}
.composer-shot-err {
  margin: 0;
  font-size: 11px;
  color: #b3453a;
  overflow-wrap: anywhere;
}
.composer-shot-acts {
  display: flex;
  gap: 6px;
  align-items: center;
}
.composer-shot-act {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid #2f7d5f;
  background: #e6f2ec;
  color: #1b5e45;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.composer-shot-x {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid #d8e2d6;
  background: #fff;
  color: #66735f;
  font-size: 12px;
  cursor: pointer;
}
.composer-shot-alert {
  margin: 6px 0 0;
  font-size: 12px;
  color: #b3453a;
}
.image-pick button.inline-check {
  font-family: inherit;
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
.voice-attach-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 210px;
  text-align: left;
}
.voice-attach-state {
  line-height: 1.35;
}
.voice-attach.tone-warn .voice-attach-state {
  color: #a06a00;
}
.voice-attach.tone-ok .voice-attach-state {
  color: #1f7a5a;
}
.voice-attach.tone-busy .voice-attach-state {
  color: #2c6fa6;
}
.voice-attach.tone-err .voice-attach-state {
  color: #c0392b;
}
.voice-attach-retry {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid #c8d5cf;
  background: #fff;
  color: #153e34;
  font-size: 11px;
}
/* 本轮引用：服务端确认的附件 */
.voice-ref {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  margin: 2px auto 8px;
  font-size: 11px;
  color: #7a8a83;
}
.voice-ref img {
  width: 26px;
  height: 26px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #d7e0db;
}
/* 拍照/选图预览 */
.vc-preview img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.vc-preview-tip {
  position: absolute;
  top: 64px;
  left: 0;
  right: 0;
  text-align: center;
  color: #fff;
  font-size: 13px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
.vc-preview-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 26px;
  display: flex;
  justify-content: space-around;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
}
.vc-preview-btn {
  flex: 1;
  padding: 12px 6px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 15px;
}
.vc-preview-btn.primary {
  background: #fff;
  color: #153e34;
  font-weight: 600;
  border-color: #fff;
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
.vc-wait {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  background: #0b1a13cc;
  color: #eaf3ec;
  text-align: center;
}
.vc-wait-cancel {
  height: 32px;
  padding: 0 20px;
  border-radius: 999px;
  border: 1px solid #ffffff3d;
  background: #ffffff12;
  color: #d7ece2;
  font-size: 13px;
}
.vc-wait-cancel:active {
  background: #ffffff22;
}
.vc-wait p {
  margin: 0;
  font-size: 14px;
  letter-spacing: 0.5px;
}
.vc-wait-ring {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid #ffffff2e;
  border-top-color: #7ee0a1;
  animation: vcWaitSpin 0.9s linear infinite;
}
@keyframes vcWaitSpin {
  to {
    transform: rotate(360deg);
  }
}

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
.voice-steps a {
  color: #12603e;
  font-weight: 600;
  text-decoration: underline;
  word-break: break-all;
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
.team-answer { white-space: pre-wrap; }.team-back { display: none; }

@media (max-width: 900px) {
  .team-filters { grid-template-columns: 1fr 1fr; }
  .team-layout { grid-template-columns: 1fr; }
  .team-list { max-height: 50vh; }
  .team-thread { max-height: none; }
  /* 手机上选中会话后详情整屏铺开：单列布局下详情在列表下方，很容易看漏 */
  .team-detail.has-conv {
    position: fixed;
    top: 0; right: 0; bottom: 0; left: 0;
    z-index: 95;
    border-radius: 0;
    border: 0;
    padding: max(12px, env(safe-area-inset-top)) 14px
      max(14px, env(safe-area-inset-bottom));
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    background: #fff;
  }
  .team-detail.has-conv .team-thread { max-height: none; overflow: visible; }
  .team-detail-head { flex-wrap: wrap; }
  .team-back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    width: 100%;
    padding: 0 0 8px;
    border: 0;
    background: none;
    color: #216b50;
    font-size: 13px;
    font-weight: 600;
  }
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

/* ── 语音通话整屏界面（沿用 10-26 那版 .vc 样式）────────── */
@keyframes voicePulse{0%{transform:scale(1);opacity:.8}to{transform:scale(1.35);opacity:0}}
@keyframes vcSpin{to{transform:rotate(360deg)}}
.vc{position:fixed;top:0;right:0;bottom:0;left:0;z-index:130;display:flex;flex-direction:column;color:#eaf6f0;background:radial-gradient(ellipse at 50% 26%,#123c2f,#0a1f18 55%,#060f0c);padding:max(12px,env(safe-area-inset-top)) 16px max(14px,env(safe-area-inset-bottom))}
.vc-setup{margin:auto;width:360px;max-width:100%;background:#fff;color:#21443a;border-radius:22px;padding:30px 24px 22px;text-align:center}
.vc-top{display:flex;align-items:center;gap:10px;position:relative}
.vc-cap{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px 0 10px;margin-left:auto;border-radius:999px;border:1px solid #ffffff2b;background:#ffffff10;color:#8fb9a9;font-size:12px;font-weight:500;letter-spacing:.6px;line-height:1;cursor:pointer;transition:background .18s ease,color .18s ease,border-color .18s ease,transform .1s ease}
.vc-cap svg{flex:none}
.vc-cap.on{background:#8ff0c42b;border-color:#8ff0c485;color:#e4fff3}
.vc-cap.on svg{color:#8ff0c4}
.vc-cap:active{transform:scale(.95)}
.vc-icon{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:#ffffff14;color:#d9efe5;border:0}
.vc-clock{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;line-height:1.25;pointer-events:none;white-space:nowrap}
.vc-clock b{font-size:15px;font-weight:600;letter-spacing:.3px}
.vc-clock span{font-size:12px;color:#9fc4b5;font-variant-numeric:tabular-nums}
.vc-mode{display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 12px;border-radius:999px;background:#ffffff14;color:#cfeee0;border:0;font-size:12px}
.vc-stage{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:6px 0}
.vc-orb{position:relative;width:176px;height:176px;display:grid;place-items:center;margin-bottom:4px}
.vc-halo{position:absolute;top:0;right:0;bottom:0;left:0;border-radius:50%;background:radial-gradient(circle,#60dca880,#60dca800 68%);transition:transform .09s linear,opacity .2s linear}
.vc-halo.h1{transform:scale(calc(.78 + var(--lv) * .42));opacity:calc(.35 + var(--lv) * .5)}
.vc-halo.h2{transform:scale(calc(.62 + var(--lv) * .3));opacity:calc(.5 + var(--lv) * .4)}
.vc-halo.h3{transform:scale(calc(.48 + var(--lv) * .18));opacity:.8}
.vc-core{position:relative;width:88px;height:88px;border-radius:50%;display:grid;place-items:center;color:#06231a;background:linear-gradient(160deg,#8ff0c4,#43c58f);box-shadow:0 0 0 1px #ffffff40,0 18px 44px #34be8a59;transform:scale(calc(1 + var(--lv) * .12));transition:transform .09s linear}
.vc-orb.is-idle .vc-core{background:linear-gradient(160deg,#cfe3d8,#9db8ab);color:#1e3b31;box-shadow:0 12px 32px #78aa9640}
.vc-orb.is-idle .vc-halo{background:radial-gradient(circle,rgba(150,190,170,.28),transparent 68%)}
.vc-orb.is-thinking .vc-core{background:linear-gradient(160deg,#ffe9a8,#e5c15c);color:#4a3a10;box-shadow:0 12px 32px #dcb95a4d}
.vc-orb.is-thinking .vc-halo{background:radial-gradient(circle,rgba(240,210,120,.45),transparent 68%)}
.vc-orb.is-speaking .vc-core{background:linear-gradient(160deg,#a9e9ff,#4fb8e8);color:#062733;box-shadow:0 12px 32px #5abee64d}
.vc-orb.is-speaking .vc-halo{background:radial-gradient(circle,rgba(120,205,240,.45),transparent 68%)}
.vc-state{margin:2px 0 0;font-size:20px;font-weight:600;letter-spacing:.5px}
.vc-hint{margin:0;font-size:13px;color:#9fc4b5;min-height:18px}
.vc-caption{width:min(520px,100%);max-height:28vh;overflow:auto}
.vc-said{margin:8px 0 0;font-size:13px;color:#9fc4b5}
.vc-say{margin:6px 0 0;font-size:16px;line-height:1.6;color:#eefaf3}
.vc-error{margin:4px 0;font-size:12.5px;color:#ffb3ae}
.vc-tts-warn{margin:4px 0;font-size:12.5px;color:#ffd7a1}
.vc-retry-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}
.vc-retry{color:#d9efe5;border:1px solid #ffffff4d;background:transparent;padding:5px 12px;border-radius:999px;font-size:12.5px;line-height:1.4;cursor:pointer}
.vc-retry.ghost{color:#b9d6c9;border-style:dashed;border-color:#ffffff33}
.vc-cam-note{display:flex;align-items:center;gap:5px;margin:2px 0;font-size:12.5px;color:#ffc9a3}
.vc-drawer{width:min(560px,100%);max-height:32vh;overflow:auto;text-align:left;background:#ffffff0f;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:10px 12px;margin-top:4px}
.vc-line{display:flex;gap:8px;padding:5px 0;font-size:13px;line-height:1.55;color:#dbeee5}
.vc-line em{flex:none;font-style:normal;color:#7fd3ab;font-weight:600}
.vc-line.assistant em{color:#8fc6e8}
.vc-empty{margin:4px 0;font-size:12px;color:#8fb2a4}
.vc-bottom{display:flex;flex-direction:column;gap:10px;align-items:center}
.vc-keys{display:flex;align-items:center;gap:12px}
.vc-key{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:62px;height:62px;border-radius:50%;border:0;background:#ffffff1a;color:#dff2e9}
.vc-key small{font-size:10.5px;opacity:.85}
.vc-key.big{width:78px;height:78px;background:#ffffff24}
.vc-key.on{background:linear-gradient(160deg,#8ff0c4,#43c58f);color:#06231a}
.vc-key.danger{background:#e0574f;color:#fff}
.vc-key:disabled{opacity:.35}
.vc-more{display:flex;align-items:center;gap:14px;font-size:12px;color:#9fc4b5;flex-wrap:wrap;justify-content:center}
.vc-more select{background:#ffffff1a;color:#eaf6f0;border:0;border-radius:8px;padding:5px 8px;font-size:12px}
.vc-tip{opacity:.7}
.vc-shot-tip{margin:6px 0 0;font-size:12px;color:#9fd8bd}
.vc-shot-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;max-height:34vh;overflow:auto}
.vc-shot{display:flex;align-items:center;gap:10px;width:auto;flex:1 1 240px;margin-top:0;padding:8px 10px;border-radius:14px;background:#ffffff12;border:1px solid rgba(255,255,255,.12);text-align:left}
.turn-shots{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.vc-shot.ok{border-color:#78dcaf73}
.vc-shot.bad{border-color:#ff8c8273}
.vc-shot img{width:56px;height:56px;flex:none;border-radius:10px;object-fit:cover;background:#0b1a15}
.vc-shot-side{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.vc-shot-label{display:flex;align-items:center;gap:4px;font-size:12.5px;color:#dff2e9}
.vc-shot.ok .vc-shot-label{color:#8ff0c4}
.vc-shot.bad .vc-shot-label{color:#ffb3ae}
.vc-shot.busy .vc-shot-label{color:#ffd98a}
.vc-shot-bar{display:block;height:3px;border-radius:3px;background:#ffffff29;overflow:hidden}
.vc-shot-bar i{display:block;height:100%;background:linear-gradient(90deg,#8ff0c4,#43c58f);transition:width .18s linear}
.vc-shot-sub{font-size:11.5px;color:#9fc4b5}
.vc-shot-err{font-size:11.5px;color:#ffb3ae}
.vc-shot-acts{display:flex;gap:6px;margin-top:2px}
.vc-shot-act{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.26);background:transparent;color:#dff2e9;font-size:11.5px}
.vc-shot-x{flex:none;width:30px;height:30px;border-radius:50%;border:0;background:#ffffff1a;color:#dff2e9;display:grid;place-items:center}
.vc-spin{animation:vcSpin .9s linear infinite}
.vc-cam{position:fixed;top:0;right:0;bottom:0;left:0;z-index:200;background:#000;display:flex;flex-direction:column}
.vc-cam video{flex:1;width:100%;min-height:0;object-fit:cover;background:#000}
.vc-cam-top{position:absolute;top:max(12px,env(safe-area-inset-top));left:12px;right:12px;display:flex;align-items:center;gap:10px;color:#eaf6f0;font-size:12.5px;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.vc-cam-bar{position:absolute;bottom:max(20px,env(safe-area-inset-bottom));left:0;right:0;display:flex;justify-content:center}
.vc-shutter{width:74px;height:74px;border-radius:50%;border:4px solid rgba(255,255,255,.85);background:transparent;display:grid;place-items:center}
.vc-shutter i{width:56px;height:56px;border-radius:50%;background:#fff;display:block}
.vc-shutter:disabled{opacity:.4}
.vc-cam-err{position:absolute;bottom:110px;left:0;right:0;text-align:center;color:#ffb3ae;font-size:12.5px;padding:0 20px}
.vc-sheet-mask{position:fixed;top:0;right:0;bottom:0;left:0;z-index:210;background:#00000073;display:flex;align-items:flex-end;justify-content:center}
.vc-sheet{width:100%;max-width:480px;background:#10231c;border-radius:18px 18px 0 0;padding:10px 12px max(14px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(255,255,255,.1)}
.vc-sheet button{display:flex;align-items:center;gap:10px;height:50px;padding:0 12px;border:0;border-radius:12px;background:transparent;color:#eaf6f0;font-size:15px}
.vc-sheet button:active{background:#ffffff14}
.vc-sheet button.cancel{color:#9fc4b5;font-size:14px;margin-top:2px;border-top:1px solid rgba(255,255,255,.08);border-radius:0 0 12px 12px}
.vc-file{display:none}

/* ── 历史随问附图 ───────────────────────── */
.turn-shot {
  display: inline-flex;
  flex-direction: column;
  margin-top: 8px;
  padding: 0;
  border: 1px solid #dbe7d6;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
  cursor: zoom-in;
}
.turn-shot img {
  display: block;
  width: 132px;
  height: 132px;
  object-fit: cover;
}
.turn-shot span {
  padding: 3px 0;
  font-size: 11px;
  text-align: center;
  color: #6d8177;
  background: #f6faf4;
}
.shot-zoom {
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  z-index: 160;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(8, 18, 14, 0.9);
}
.shot-zoom img {
  max-width: 100%;
  max-height: 86vh;
  border-radius: 10px;
}
.shot-zoom-x {
  position: absolute;
  top: max(14px, env(safe-area-inset-top));
  right: 14px;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: #ffffff1f;
  color: #eaf6f0;
}

/* ── 语音底栏（参照通话类应用：中间一个大按钮，两侧次要操作）─── */
.vc-dock {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 4px 2px;
}
.vc-dock-aux {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.vc-mini {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  background: #ffffff12;
  color: #cfeee0;
  font-size: 12px;
}
.vc-dock-set {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  align-self: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid #ffffff1f;
  background: #ffffff10;
  color: #bcd9cc;
  font-size: 12px;
}
.vc-dock-set span {
  max-width: 62vw;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.vc-dock-set:active {
  background: #ffffff1f;
}
.vc-set {
  gap: 6px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.vc-set-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 12px 8px;
}
.vc-set-head b {
  font-size: 15px;
  color: #eaf6f0;
}
.vc-set-head span {
  font-size: 12px;
  color: #8fb9a9;
}
.vc-set-label em {
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: #e6c08a;
  margin-left: 6px;
}
.vc-set-label {
  margin: 6px 12px 2px;
  font-size: 12px;
  color: #8fb9a9;
}
.vc-set-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px 4px;
}
.vc-chip {
  display: flex !important;
  flex-direction: column;
  align-items: flex-start !important;
  justify-content: center;
  gap: 1px !important;
  height: auto !important;
  min-height: 48px;
  padding: 8px 12px !important;
  border-radius: 12px !important;
  border: 1px solid #ffffff1f !important;
  background: #ffffff0d !important;
  color: #cfe7db !important;
  line-height: 1.2;
}
.vc-chip b {
  font-size: 14px;
  font-weight: 500;
}
.vc-chip small {
  font-size: 11px;
  color: #86ab9c;
}
.vc-chip.rate {
  min-width: 66px;
  align-items: center !important;
}
.vc-chip.on {
  background: #8ff0c426 !important;
  border-color: #8ff0c480 !important;
  color: #e6fff4 !important;
}
.vc-chip.on small {
  color: #a9d8c4;
}
.vc-set-foot {
  display: flex;
  gap: 10px;
  padding: 10px 12px 2px;
}
.vc-set-foot button {
  flex: 1;
  display: flex !important;
  align-items: center;
  justify-content: center;
  height: 46px;
  border-radius: 12px;
  border: 1px solid #ffffff26;
  background: #ffffff10;
  color: #d9efe5;
  font-size: 15px;
}
.vc-set-done {
  background: #34be8a !important;
  border-color: #34be8a !important;
  color: #062a1e !important;
  font-weight: 500;
}
.vc-mini select {
  border: 0;
  background: transparent;
  color: #eaf6f0;
  font-size: 12px;
  outline: none;
  padding-right: 2px;
}
.vc-mini select option {
  color: #123c2f;
}
.vc-dock-note {
  font-size: 11px;
  color: #7fa595;
}
.vc-dock-main {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 64px;
  align-items: center;
  gap: 16px;
  padding: 0 2px;
}
.vc-round {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 50%;
  background: #ffffff14;
  color: #d9efe5;
  font-size: 11px;
}
.vc-round span {
  font-size: 11px;
  line-height: 1;
}
.vc-round.danger {
  background: #e5484d2e;
  color: #ffc3c4;
  box-shadow: inset 0 0 0 1px #e5484d59;
}
.vc-round.on {
  background: #8ff0c42e;
  color: #d6ffe9;
}
.vc-talk {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  justify-self: center;
  width: 112px;
  height: 112px;
  border: 0;
  border-radius: 50%;
  background: linear-gradient(160deg, #8ff0c4, #43c58f);
  color: #06231a;
  box-shadow: 0 14px 34px #34be8a59;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.vc-talk em {
  font-style: normal;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.vc-talk.on {
  transform: scale(0.94);
  box-shadow: 0 8px 18px #34be8a3d;
}
.vc-talk.busy {
  background: linear-gradient(160deg, #ffe9a8, #e5c15c);
  color: #4a3a10;
}
.vc-icon.on {
  background: #8ff0c433;
  color: #d6ffe9;
}
@media (max-width: 380px) {
  .vc-talk {
    width: 96px;
    height: 96px;
  }
  .vc-dock-main {
    grid-template-columns: 56px minmax(0, 1fr) 56px;
  }
  .vc-round {
    width: 56px;
    height: 56px;
  }
}

/* ── 文字页附图入口：拍照 / 相册 并排 ─────────────────────── */
.image-pick {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* 手机上两个按钮各占一半，不要上下各占一整行 */
@media (max-width: 760px) {
  .form-bottom .image-pick { width: 100%; }
  .form-bottom .image-pick .inline-check {
    width: auto;
    flex: 1 1 0;
    justify-content: center;
    padding: 10px 12px;
  }
}

/* ── 历史会话：工具条 + 左侧抽屉 ─────────────────────────── */
.chat-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.chat-bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.chat-bar-btn em {
  font-style: normal;
  font-size: 11px;
  line-height: 17px;
  min-width: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: #e7efe6;
  color: #3f6b4d;
  text-align: center;
}
/* 后台任务提示条：只在有别的会话还在生成时出现，窄屏也能点 */
.bg-tasks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 9px 12px;
  border: 1px solid #d8e4d6;
  border-left: 3px solid #3f6b4d;
  border-radius: 10px;
  background: #f5faf4;
}
.bg-tasks-label {
  font-size: 13px;
  color: #3f6b4d;
  white-space: nowrap;
}
.bg-tasks ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 0;
}
.bg-tasks li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
}
.bg-open {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid #d8e4d6;
  background: #fff;
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 13px;
  color: #2f5138;
  cursor: pointer;
}
.bg-pending {
  font-size: 12px;
  color: #8a6d3b;
}
/* 测试版标识：颜色偏琥珀，避免和"成功/正常"徽标混淆 */
.test-flag {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-banner {
  margin: 6px 0 12px;
  padding: 7px 10px;
  border-radius: 8px;
  background: #fdf3e0;
  border: 1px solid #f0d9ad;
  color: #8a5a12;
  font-size: 12px;
  line-height: 1.5;
}
.conv-drawer-mask {
  position: fixed;
  inset: 0;
  background: #0d1a1247;
  z-index: 300;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.conv-drawer-mask.show {
  opacity: 1;
  pointer-events: auto;
}
.conv-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(84vw, 330px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px calc(16px + env(safe-area-inset-bottom));
  background: #fff;
  box-shadow: 2px 0 28px #0d1a1226;
  z-index: 301;
  transform: translateX(-102%);
  transition: transform 0.22s ease, visibility 0s 0.22s;
  visibility: hidden;
}
.conv-drawer.open {
  transform: none;
  visibility: visible;
  transition: transform 0.22s ease, visibility 0s 0s;
}
.conv-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.conv-drawer-head strong {
  font-size: 15px;
}
.conv-drawer-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #5d7364;
  cursor: pointer;
}
.conv-drawer-x:active {
  background: #eef3ec;
}
.conv-drawer-search {
  width: 100%;
  height: 36px;
  border-radius: 9px;
  border: 1px solid #d8e2d6;
  background: #f7faf6;
  padding: 0 11px;
  font: inherit;
  font-size: 13px;
}
.conv-drawer-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
}
.conv-drawer-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: 8px;
}
.conv-group {
  margin: 12px 0 6px;
  padding-left: 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: #8a9b8e;
}
.conv-drawer-list .conversation {
  margin-bottom: 2px;
}
.conv-drawer-list .conv-delete {
  top: 50%;
  transform: translateY(-50%);
}
.conv-empty {
  padding: 18px 8px;
  line-height: 1.6;
}
/* 触屏没有 hover：删除按钮必须常显，否则永远点不到 */
@media (hover: none) {
  .conv-delete {
    opacity: 1;
    background: #f7eeeb;
  }
}
</style>
