#!/usr/bin/env python3
"""本地语音服务：SenseVoice 识别（whisper 兜底） + 本地 MeloTTS 合成（edge 兜底）。

仅监听 127.0.0.1，由 Node 后端反代。
    GET  /health          -> {"ok":true,"asr":true/false,"asrEngine":"sensevoice",...}
    POST /asr?ext=webm    -> 原始音频字节，返回 {"text":"..."}
    POST /tts             -> {"text":"...","voice":"zh-CN-XiaoxiaoNeural"}，返回 audio/wav|mpeg
"""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.getenv("VOICE_PORT", "8790"))
MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
CACHE_DIR = os.getenv("VOICE_CACHE", os.path.expanduser("~/.cache/agri-voice"))
DEFAULT_VOICE = os.getenv("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
MAX_AUDIO = 12 * 1024 * 1024

# 识别偏置：whisper 的 initial_prompt 只吃末尾约 224 token，所以要短、要密。
# 把园区高频专有名词塞进去，能明显压低同音字错（"卷帘机"听成"卷连机"这类）。
ASR_PROMPT = (
    "以下是大棚温室农业的普通话对话，可能提到卷帘机、限位开关、行程开关、"
    "交流接触器、继电器、断路器、端子排、控制柜、风口、遮阳网、棚膜、"
    "滴灌、水肥一体化、育苗基质、蛭石、珍珠岩、椰糠、缓苗、授粉、疏花疏果，"
    "以及蚜虫、白粉虱、蓟马、红蜘蛛、灰霉病、白粉病、霜霉病、根结线虫，"
    "还有多菌灵、代森锰锌、吡虫啉、阿维菌素、磷酸二氢钾等农药肥料名称。"
)

# 术语纠错：只收录"错形在中文里几乎不会独立出现"的组合，避免误改用户原意。
# 宁可漏改，不要错改——错改会改变用户的问题本身。
ASR_TERM_FIX = (
    ("卷连机", "卷帘机"),
    ("卷帘基", "卷帘机"),
    ("线位开关", "限位开关"),
    ("形成开关", "行程开关"),
    ("端字排", "端子排"),
    ("至石", "蛭石"),
    ("智石", "蛭石"),
    ("珠珍岩", "珍珠岩"),
    ("椰康", "椰糠"),
    ("灰煤病", "灰霉病"),
    ("挥霉病", "灰霉病"),
    ("双霉病", "霜霉病"),
    ("膀里", "棚里"),
    ("蓬礼", "棚里"),
    ("膏容易", "容易"),
    ("白粉师", "白粉虱"),
    ("计马", "蓟马"),
    ("根结现虫", "根结线虫"),
    ("促倒病", "猝倒病"),
    ("梳花梳果", "疏花疏果"),
    ("受粉", "授粉"),
    ("多菌零", "多菌灵"),
    ("密霉胺", "嘧霉胺"),
    ("嘧霉安", "嘧霉胺"),
    ("阿维霉素", "阿维菌素"),
    ("磷酸二氢甲", "磷酸二氢钾"),
)

# ── 同音纠错 ──────────────────────────────────────────────────
# SenseVoice 没有 whisper 的 initial_prompt 热词偏置，专有名词会按读音乱写。
# 实测错法：「嘧霉胺→蜜霉暗」「蛭石→智石」「珍珠岩→珍珠眼」「吡虫啉→比虫林」
# 「啶虫脒→定虫米」「叶面喷施→液面喷湿」。这些错的共同点是——拼音一模一样。
# 所以用领域词表做同音比对：只改读音完全一致的字。
# 这比"编辑距离模糊匹配"安全：距离算法会把「温度」改成「湿度」（只差一个字），
# 而同音比对不会，因为 wen du 和 shi du 不同音。
# 长度只取 3 字以上：两字词的同音撞车太多（蛭石↔知识、椰糠↔夜康），
# 两字词交给上面的 ASR_TERM_FIX 精确列。
ASR_GLOSSARY = (
    "卷帘机", "限位开关", "行程开关", "交流接触器", "继电器", "断路器", "端子排",
    "控制柜", "遮阳网", "滴灌带", "水肥一体化", "育苗基质", "珍珠岩", "疏花疏果",
    "白粉虱", "红蜘蛛", "灰霉病", "白粉病", "霜霉病", "根结线虫", "猝倒病",
    "多菌灵", "代森锰锌", "吡虫啉", "阿维菌素", "磷酸二氢钾", "嘧霉胺", "啶虫脒",
    "叶面喷施", "保温被", "补光灯", "缓苗期", "花芽分化", "保花保果", "二氧化碳",
    "营养液", "电导率", "温湿度", "环流风机", "防虫网", "潜水泵", "漏电保护器",
    "电动卷膜器", "卷膜器", "放风机", "温控仪", "时控开关", "变频器", "三相电",
    "定植水", "蘸花", "落蔓",
)

_GLOSSARY_BY_PY = {}
_GLOSSARY_LENS = []
try:
    from functools import lru_cache

    from pypinyin import lazy_pinyin as _lazy_pinyin

    # 只收 3 字以上：两字词同音撞车太多（蛭石↔知识、椰糠↔夜康），
    # 两字词由 ASR_TERM_FIX 精确列。
    for _t in ASR_GLOSSARY:
        if len(_t) < 3:
            continue
        _GLOSSARY_BY_PY.setdefault(tuple(_lazy_pinyin(_t)), _t)
    _GLOSSARY_LENS = sorted({len(t) for t in ASR_GLOSSARY if len(t) >= 3}, reverse=True)
    del _t

    @lru_cache(maxsize=4096)
    def _win_pinyin(win: str):
        return tuple(_lazy_pinyin(win))

except Exception as _exc:  # noqa: BLE001  pypinyin 缺失时静默降级，只是少一层纠错
    print(f"[voice] 同音纠错未启用（缺 pypinyin）: {_exc}", flush=True)

    def _win_pinyin(win: str):
        return ()


def fix_homophones(text: str) -> str:
    if not text or not _GLOSSARY_LENS:
        return text
    out = []
    i = 0
    n = len(text)
    while i < n:
        hit = None
        for L in _GLOSSARY_LENS:
            if i + L > n:
                continue
            win = text[i : i + L]
            # 只处理全中文窗口：数字、字母按 ITN 归一后不该被改
            if not win.isascii() and all("\u4e00" <= c <= "\u9fff" for c in win):
                term = _GLOSSARY_BY_PY.get(_win_pinyin(win))
                if term:
                    hit = (L, term)
                    break
        if hit:
            out.append(hit[1])
            i += hit[0]
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u2190-\u21FF\u2B00-\u2BFF]"
)

# 需要看上下文的纠错：不能无脑把「大鹏」改成「大棚」（有人名就叫大鹏），
# 只在后面跟着作物/棚体/农事词时才改。
ASR_CONTEXT_FIX = (
    (
        re.compile(
            r"大[鹏朋](?=番茄|黄瓜|辣椒|茄子|草莓|西瓜|甜瓜|棚|里|膜|种植|蔬菜|大棚|作物)"
        ),
        "大棚",
    ),
    # 「打」被听成「胆」：胆字在农业语境里几乎不会单独出现，跟着病害名后面必然是「打」
    (re.compile(r"(?<=[病虫草])胆"), "打"),
    # 「基质里」→「基质理」，理在此处无意义
    (re.compile(r"(?<=基质)理(?=[\u4e00-\u9fff])"), "里"),
)
_CN_NUM = "一二三四五六七八九十"


def _ordinal(m):
    n = int(m.group(1))
    return f"第{_CN_NUM[n - 1]}，" if 1 <= n <= 10 else ""


def speech_text(text: str) -> str:
    """把 Markdown 转成可朗读文本（与后端 answer-guard.mjs 的 stripForSpeech 同口径）。

    语音轮本身已由提示词约束不用 Markdown，这里是兜底：只要前端把整段回答送来朗读，
    也不会念出"星号星号""减号""竖线"。只剥标记，不改语义。
    """
    if not text:
        return ""
    s = text
    s = re.sub(r"```[\s\S]*?```", "。", s)
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"^\s*[-*_]{3,}\s*$", "", s, flags=re.M)
    s = re.sub(r"^\s*\|?[\s:|-]{5,}\|?\s*$", "", s, flags=re.M)
    s = re.sub(r"^\s{0,3}#{1,6}\s*", "", s, flags=re.M)
    s = re.sub(r"^\s{0,3}>\s?", "", s, flags=re.M)
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"__([^_]+)__", r"\1", s)
    s = re.sub(r"~~([^~]+)~~", r"\1", s)
    s = re.sub(r"\s*\|\s*", "，", s)
    s = re.sub(r"^\s*(\d{1,2})\s*[.)、]\s*", _ordinal, s, flags=re.M)
    s = re.sub(r"^\s*[-*+]\s+", "", s, flags=re.M)
    s = re.sub(r"^\s*\[[ xX]\]\s*", "", s, flags=re.M)
    s = _EMOJI_RE.sub("", s)
    s = re.sub(r"[（(]\s*[)）]", "", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"。{2,}", "。", s)
    s = re.sub(r"，{2,}", "，", s)
    s = re.sub(r"^[ \t]+", "", s, flags=re.M)
    return s.strip()


os.makedirs(CACHE_DIR, exist_ok=True)

# ── 识别（ASR）────────────────────────────────────────────────
# 2026-10-28 换主引擎，原因是实测：faster-whisper-small 在农业短句上字错率
# 10~17%，一句要 1.5 秒，噪声越大掉得越狠（"卷帘机"→"2年金"、"根系"→"珍细"）。
# SenseVoiceSmall 是非自回归端到端模型，同一批测试 6%，5 秒音频 55 毫秒
# （RTF 0.011），5dB 噪声下几乎不退化。
# 但边界也清楚：只覆盖 中/粤/英/日/韩，方言不支持；长音频和罕见专名不如
# whisper-large。所以是"主用 SenseVoice + 兜底 whisper"，不是把 whisper 删掉。
ASR_ENGINE = os.getenv("ASR_ENGINE", "auto").strip().lower()  # auto|sensevoice|whisper
ASR_LANG = os.getenv("ASR_LANG", "zh")
ASR_THREADS = int(os.getenv("ASR_THREADS", "4"))
SENSEVOICE_DIR = os.getenv(
    "SENSEVOICE_DIR",
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "models",
        "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ),
)

_sv = None
_sv_error = ""
_sv_lock = threading.Lock()
# 一个 recognizer 被多个请求共享时，并发 decode 在旧版本 sherpa-onnx 上会偶发崩，
# 而单句只要 55ms，串行化的代价可以忽略，换稳定。
_sv_decode_lock = threading.Lock()

_model = None
_model_error = None
_whisper_on = os.getenv("ASR_WHISPER", "1").strip().lower() not in ("0", "false", "no")


def load_sensevoice():
    """加载 SenseVoice（sherpa-onnx int8，229MB）。失败不影响 whisper 兜底。"""
    global _sv, _sv_error
    try:
        import glob

        import sherpa_onnx

        d = SENSEVOICE_DIR
        if not os.path.isdir(d):
            raise RuntimeError("SenseVoice 目录不存在：" + d)
        # 目录里同时有 model.onnx(895MB fp16) 与 model.int8.onnx(229MB)。
        # 推理只用 int8：精度差异在实测里没体现，体积和内存差 4 倍。
        onnx = os.path.join(d, "model.int8.onnx")
        if not os.path.exists(onnx):
            cands = sorted(glob.glob(os.path.join(d, "model*.onnx")))
            if not cands:
                raise RuntimeError("SenseVoice 目录里没有 onnx：" + d)
            onnx = cands[0]
        tokens = os.path.join(d, "tokens.txt")
        if not os.path.exists(tokens):
            raise RuntimeError("SenseVoice 缺 tokens.txt：" + d)
        _sv = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=onnx,
            tokens=tokens,
            num_threads=ASR_THREADS,
            use_itn=True,  # 带标点 + 数字归一（"八十五"→"85"），后接大模型更顺
            language=ASR_LANG,
            debug=False,
        )
        print(f"[voice] sensevoice ready ({os.path.basename(onnx)})", flush=True)
    except Exception as exc:  # noqa: BLE001
        _sv_error = repr(exc)
        print(f"[voice] sensevoice 不可用: {exc}", flush=True)


def asr_engine_name() -> str:
    if ASR_ENGINE == "whisper":
        return "whisper"
    if _sv is not None:
        return "sensevoice"
    if _model is not None:
        return "whisper"
    return "none"


def resolve_sv_audio(data: bytes, ext: str):
    """把任意容器（webm/ogg/m4a/wav）解成 16k 单声道 float32。

    用 faster-whisper 自带的 PyAV 解码，不额外引入 ffmpeg 命令行依赖。
    """
    import tempfile

    from faster_whisper.audio import decode_audio

    suffix = ext if ext.startswith(".") else "." + ext
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return decode_audio(path, sampling_rate=16000)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


_SV_TAG_RE = re.compile(r"<\|[^|]*\|>")


def transcribe_sensevoice(data: bytes, ext: str) -> str:
    if _sv is None:
        raise RuntimeError(_sv_error or "SenseVoice 未就绪")
    audio = resolve_sv_audio(data, ext)
    if audio is None or len(audio) == 0:
        return ""
    with _sv_decode_lock:
        stream = _sv.create_stream()
        stream.accept_waveform(16000, audio)
        _sv.decode_stream(stream)
        text = stream.result.text or ""
    # 模型偶尔会把情感/语种标签带出来（<|zh|><|NEUTRAL|>），这里统一剥掉
    return _SV_TAG_RE.sub("", text).strip()


def resolve_model_path() -> str:
    """优先用本地快照目录，避免运行时联网校验（国内网络常卡住）。"""
    explicit = os.getenv("WHISPER_MODEL_PATH")
    if explicit and os.path.isdir(explicit):
        return explicit
    base = os.path.expanduser(
        f"~/.cache/huggingface/hub/models--Systran--faster-whisper-{MODEL_SIZE}/snapshots"
    )
    if os.path.isdir(base):
        for name in sorted(os.listdir(base), reverse=True):
            path = os.path.join(base, name)
            if os.path.isdir(path):
                return path
    return MODEL_SIZE


def load_model():
    global _model, _model_error
    if not _whisper_on:
        print("[voice] whisper 兜底已关闭（ASR_WHISPER=0）", flush=True)
        return
    try:
        from faster_whisper import WhisperModel

        target = resolve_model_path()
        _model = WhisperModel(
            target,
            device="cpu",
            compute_type="int8",
            cpu_threads=int(os.getenv("WHISPER_THREADS", "8")),
            local_files_only=True,
        )
        print(f"[voice] whisper {MODEL_SIZE} ready ({target})", flush=True)
    except Exception as exc:  # noqa: BLE001
        _model_error = str(exc)
        print(f"[voice] whisper load failed: {exc}", flush=True)


def transcribe_whisper(data: bytes, ext: str) -> str:
    if _model is None:
        raise RuntimeError(_model_error or "识别模型尚未就绪")
    fd, path = tempfile.mkstemp(suffix=ext if ext.startswith(".") else "." + ext)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        segments, _info = _model.transcribe(
            path,
            language="zh",
            # beam_size=1 是贪心解码，快但同音字错多；5 会用候选打分挑更通顺的结果。
            # 实测可以按延迟预算调节：WHISPER_BEAM=5 通常多花 1 倍左右时间。
            beam_size=int(os.getenv("WHISPER_BEAM", "1")),
            vad_filter=True,
            condition_on_previous_text=False,
            initial_prompt=ASR_PROMPT,
        )
        text = "".join(s.text for s in segments).strip()
        return text
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


_PUNCT_ONLY_RE = re.compile(r"[\s，。！？、,.!?…~～—\-·:：;；\"'“”‘’()（）]+")


def _meaningful(text: str) -> bool:
    """识别结果是否含实义字。SenseVoice 对纯噪声会吐「。」或空串，
    这种情况要走 whisper 再看一眼，而不是把空问题丢给大模型。"""
    return bool(_PUNCT_ONLY_RE.sub("", text or ""))


def postprocess_asr(text: str) -> str:
    """识别后处理：上下文纠错 → 精确替换 → 同音纠错 → 再来一遍上下文纠错。

    最后一轮不是多余：同音纠错会把「育苗机治」改成「育苗基质」，
    而「基质理」里的「理」要在「基质」出现之后才认得出来。
    """
    if not text:
        return ""
    for pattern, right in ASR_CONTEXT_FIX:
        text = pattern.sub(right, text)
    for wrong, right in ASR_TERM_FIX:
        text = text.replace(wrong, right)
    text = fix_homophones(text)
    for pattern, right in ASR_CONTEXT_FIX:
        text = pattern.sub(right, text)
    return text.strip()


def transcribe(data: bytes, ext: str, engine: str = "") -> str:
    """识别主入口：SenseVoice 优先，异常/空结果回落 whisper。

    engine 只给调试/AB 用（"whisper" / "sensevoice"），留空则按 ASR_ENGINE 走。
    """
    engine = (engine or ASR_ENGINE).strip().lower()
    text = ""
    if engine == "whisper":
        text = transcribe_whisper(data, ext)
    else:
        try:
            text = transcribe_sensevoice(data, ext)
        except Exception as exc:  # noqa: BLE001
            print(f"[voice] sensevoice 失败，回落 whisper: {exc}", flush=True)
            if engine == "sensevoice" and _model is None:
                raise
        # 空结果 / 全噪声：whisper 再看一眼，别把空问题丢给大模型
        if not _meaningful(text) and _model is not None:
            try:
                alt = transcribe_whisper(data, ext)
                if _meaningful(alt):
                    print("[voice] sensevoice 空结果，采用 whisper", flush=True)
                    text = alt
            except Exception as exc:  # noqa: BLE001
                print(f"[voice] whisper 兜底也失败: {exc}", flush=True)

    return postprocess_asr(text)

# ── 本地离线合成（sherpa-onnx + 中文 VITS）──────────────────────
# 为什么要有它：edge-tts 走的是微软免费接口，2026-10-28 14:34 起
# 大面积返回 NoAudioReceived，单句 7–13 秒、并发还串行。语音通话是核心交互，
# 不能把体验押在一个随时抖动的免费接口上。本地引擎稳定在几百毫秒。
#
# 2026-10-28 换模型：vits-zh-hf-fanchen-C → vits-melo-tts-zh_en。
# 前者是较早的中文 VITS 小模型，字间偏机械、句尾语调收得生硬，用户反馈"别扭"；
# MeloTTS 是专门为中英混读训练的，同机实测单句 0.60s（旧的 0.66s），
# 44.1kHz 输出，"NPK 15-15-15"这类掺英文的表达也不会念成字母串。
_TTS_LOCAL_DIR = os.getenv(
    "TTS_LOCAL_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "vits-melo-tts-zh_en"),
)
# 换模型必须换缓存命名空间：缓存 key 只算 (音色+文本)，
# 不带上模型标识的话，用户会听到上一版模型留下的 wav，以为"改了没生效"。
_TTS_MODEL_TAG = os.getenv("TTS_MODEL_TAG", "melo-zh-en@24k")
# 输出采样率。MeloTTS 原生 44100，改 24000 省掉近一半传输体积；
# 设 0 则保持模型原生采样率（想对比音质时用）。
_TTS_SR_OUT = int(os.getenv("TTS_LOCAL_SR", "24000"))
# auto  = 本地优先，云端 2 秒内回得来就仍用云端音色（用户选的音色不丢）
# local = 只用本地；edge = 只用云端
_TTS_ENGINE = os.getenv("TTS_ENGINE", "auto")
_TTS_EDGE_WAIT = float(os.getenv("TTS_EDGE_WAIT", "2.0"))
_tts_local = None
_tts_local_err = ""
_tts_local_lock = threading.Lock()


def local_engine():
    global _tts_local, _tts_local_err
    if _tts_local is not None:
        return _tts_local
    with _tts_local_lock:
        if _tts_local is not None:
            return _tts_local
        try:
            import sherpa_onnx

            d = _TTS_LOCAL_DIR
            import glob

            # 不同模型的 onnx 文件名不一样（model.onnx / theresa.onnx 等），按目录自动找。
            # 必须优先取全精度：melo 目录里同时有 model.int8.onnx，
            # 按文件名排序会先拿到 int8，加载直接报 Protobuf parsing failed。
            onnx_files = sorted(glob.glob(os.path.join(d, "*.onnx")))
            full_precision = [
                f for f in onnx_files if ".int8." not in os.path.basename(f)
            ]
            onnx_files = full_precision or onnx_files
            if not onnx_files:
                raise RuntimeError("模型目录里没有 .onnx：" + d)
            cfg = sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=onnx_files[0],
                        lexicon=os.path.join(d, "lexicon.txt"),
                        tokens=os.path.join(d, "tokens.txt"),
                        dict_dir=os.path.join(d, "dict"),
                    ),
                    # MeloTTS 实测 4 线程与 8 线程都是 0.60s（已到瓶颈），
                    # 取 4 留出余量给"预取 3 句"的并发合成。可用 TTS_THREADS 覆盖。
                    num_threads=max(2, int(os.getenv("TTS_THREADS", "4"))),
                    provider="cpu",
                ),
                rule_fsts=",".join(
                    p
                    for p in (
                        os.path.join(d, "phone.fst"),
                        os.path.join(d, "date.fst"),
                        os.path.join(d, "number.fst"),
                        # 多音字规则：「番茄」的茄、「叶脉」的脉，没有这条会念错
                        os.path.join(d, "new_heteronym.fst"),
                    )
                    if os.path.exists(p)
                ),
                max_num_sentences=1,
            )
            _tts_local = sherpa_onnx.OfflineTts(cfg)
            print(f"[voice] 本地 TTS 就绪 {d} ({os.path.basename(onnx_files[0])})", flush=True)
        except Exception as exc:  # 模型缺失/onnx 异常都不能拖垮整个语音服务
            _tts_local_err = repr(exc)
            print(f"[voice] 本地 TTS 不可用: {exc}", flush=True)
    return _tts_local


def _wav(samples, sr):
    import io
    import wave

    import numpy as np

    # 逐样本走 Python 生成器转 int16 太慢：一句 6 秒 24kHz 有 26 万样本，
    # 光是格式转换就吃掉 100~200ms，比合成本身还显眼。numpy 一次算完。
    pcm = np.clip(
        np.asarray(samples, dtype=np.float32) * 32767.0, -32768.0, 32767.0
    ).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _resample(samples, src_sr, dst_sr):
    """FFT 重采样。MeloTTS 原生 44.1kHz，一句 5 秒的 wav 有 416KB，
    手机上光下载就够呛；降到 24kHz 体积砍掉近一半，语音听感几乎无差。
    没有 scipy，用 numpy 的 rfft/irfft 做，截断高频比直接抽点干净（不会混叠）。"""
    if not dst_sr or dst_sr == src_sr or not len(samples):
        return samples, src_sr
    import numpy as np

    x = np.asarray(samples, dtype=np.float32)
    n = x.size
    m = int(round(n * dst_sr / src_sr))
    if m <= 0:
        return samples, src_sr
    spec = np.fft.rfft(x)
    k = m // 2 + 1
    if k <= spec.size:
        spec = spec[:k]
    else:
        spec = np.concatenate([spec, np.zeros(k - spec.size, dtype=spec.dtype)])
    y = np.fft.irfft(spec, m) * (m / n)  # 频点数变化后要补回幅度
    return y, dst_sr  # 直接给 ndarray，_wav 里省掉一次 tolist 拷贝


def synth_local(text: str) -> bytes:
    tts = local_engine()
    if tts is None:
        raise RuntimeError(_tts_local_err or "本地 TTS 未就绪")
    audio = tts.generate(text, sid=0, speed=1.0)
    if not audio.samples:
        raise RuntimeError("本地 TTS 无输出")
    samples, sr = _resample(audio.samples, audio.sample_rate, _TTS_SR_OUT)
    return _wav(samples, sr)


def synth_edge(text: str, voice: str) -> bytes:
    """云端合成。重试是"同一次失败最多再试两次"，不是"试到成功为止"。

    之前没有总预算：三次尝试各自卡在网络超时上，一次请求能拖到二十几秒，
    前端早就放弃了，这边还在跑——既拖慢后续句子，也白占连接。
    现在给一个总预算（TTS_EDGE_BUDGET，默认 6 秒），超了就认输，交给本地兜底。
    """
    import edge_tts

    async def run(v: str) -> bytes:
        buf = bytearray()
        async for chunk in edge_tts.Communicate(text, v).stream():
            if chunk.get("type") == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    budget = float(os.getenv("TTS_EDGE_BUDGET", "6"))
    started = time.monotonic()
    attempts = [(voice, 0.0), (voice, 0.0), (DEFAULT_VOICE, 0.0)]
    last = "unknown"
    for idx, (v, wait) in enumerate(attempts):
        if time.monotonic() - started > budget:
            last = f"{last}（总预算 {budget:.0f}s 用完，剩 {len(attempts) - idx} 次没试）"
            print(f"[voice] tts 放弃重试: {last}", flush=True)
            break
        if wait:
            time.sleep(wait)
        try:
            data = asyncio.run(run(v))
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
            print(f"[voice] tts 重试 voice={v}: {exc}", flush=True)
            continue
        if not data:
            last = "empty audio"
            continue
        return data
    raise RuntimeError("tts 连续失败: " + last)


def synth(text: str, voice: str):
    """返回 (音频字节, MIME)。云端音色优先，云端慢了立刻用本地顶上。"""
    tts_voice = str(voice or DEFAULT_VOICE)
    # 本地缓存的 key 带上模型标识：只算 (音色+文本) 的话，换了本地模型之后
    # 老缓存仍会命中，用户听到的还是上一版模型的音色，看起来像"改了没生效"。
    key = hashlib.sha1(
        (_TTS_MODEL_TAG + "\n" + tts_voice + "\n" + text).encode("utf-8")
    ).hexdigest()
    edge_path = os.path.join(CACHE_DIR, key + ".mp3")
    local_path = os.path.join(CACHE_DIR, key + ".local.wav")

    def read(p):
        with open(p, "rb") as fh:
            return fh.read()

    def save(p, data):
        tmp = p + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, p)

    if _TTS_ENGINE == "local":
        # 本地模式只认本地缓存：否则会捡到之前云端留下的 mp3，
        # 同一轮对话里一半云端音色一半本地音色，听着像两个人
        if os.path.exists(local_path):
            return read(local_path), "audio/wav"
        data = synth_local(text)
        save(local_path, data)
        return data, "audio/wav"

    if os.path.exists(edge_path):
        return read(edge_path), "audio/mpeg"

    if _TTS_ENGINE == "edge":
        try:
            data = synth_edge(text, tts_voice)
        except Exception as exc:  # noqa: BLE001
            # 云端失败不能让这一句直接没声音：本地引擎还在，切过去念
            print(f"[voice] 云端合成失败，改用本地: {exc}", flush=True)
            data = synth_local(text)
            save(local_path, data)
            return data, "audio/wav"
        save(edge_path, data)
        return data, "audio/mpeg"

    # auto：先把云端请求丢到后台，等一小会儿；等不及就让本地先出声。
    # 云端线程继续跑，成功了会写进缓存，下次同一句仍是云端音色。
    if os.path.exists(local_path):
        return read(local_path), "audio/wav"

    box = {}

    def run_edge():
        try:
            d = synth_edge(text, tts_voice)
            save(edge_path, d)
            box["ok"] = d
        except Exception as exc:
            box["err"] = repr(exc)

    th = threading.Thread(target=run_edge, daemon=True)
    th.start()
    th.join(_TTS_EDGE_WAIT)
    if box.get("ok"):
        return box["ok"], "audio/mpeg"

    try:
        data = synth_local(text)
        save(local_path, data)
        return data, "audio/wav"
    except Exception as exc:
        print(f"[voice] 本地 TTS 也失败: {exc}", flush=True)

    th.join(25)
    if box.get("ok"):
        return box["ok"], "audio/mpeg"
    raise RuntimeError("tts 全部失败: " + str(box.get("err") or "unknown"))
    key = hashlib.sha1((voice + "\n" + text).encode("utf-8")).hexdigest()
    path = os.path.join(CACHE_DIR, key + ".mp3")
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read()

    import edge_tts

    async def run(v: str) -> bytes:
        buf = bytearray()
        async for chunk in edge_tts.Communicate(text, v).stream():
            if chunk.get("type") == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    # 微软免费接口会间歇性返回空音频（edge_tts.exceptions.NoAudioReceived），
    # 同一句话隔几百毫秒重试基本都能过；最后再用默认音色兜一次。
    attempts = [(voice, 0.0), (voice, 0.25), (voice, 0.5), (DEFAULT_VOICE, 0.4)]
    last = "unknown"
    for v, wait in attempts:
        if wait:
            time.sleep(wait)
        try:
            data = asyncio.run(run(v))
        except Exception as exc:  # NoAudioReceived / 网络抖动 / 401 都走重试
            last = repr(exc)
            print(f"[voice] tts 重试 voice={v}: {exc}", flush=True)
            continue
        if not data:
            last = "empty audio"
            print(f"[voice] tts 空音频 voice={v}", flush=True)
            continue
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        return data
    raise RuntimeError("tts 连续失败: " + last)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AgriVoice/1.0"

    def log_message(self, fmt, *args):  # 精简日志
        print("[voice] " + (fmt % args), flush=True)

    def _send(self, status, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {
                "ok": True,
                "asr": (_sv if ASR_ENGINE != "whisper" else None) is not None or _model is not None,
                "asrEngine": asr_engine_name(),
                "asrSenseVoice": _sv is not None,
                "asrSenseVoiceError": _sv_error,
                "asrWhisper": _model is not None,
                "asrError": _model_error,
                "tts": True,
                "ttsEngine": _TTS_ENGINE,
                "ttsLocal": bool(_tts_local),
                "ttsModel": _TTS_MODEL_TAG,
                "model": MODEL_SIZE,
            })
        self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return self._json(400, {"error": "空请求"})
            if length > MAX_AUDIO:
                return self._json(413, {"error": "请求过大"})
            body = self.rfile.read(length)

            if self.path.startswith("/asr"):
                ext = ".webm"
                if "ext=" in self.path:
                    ext = "." + self.path.split("ext=", 1)[1].split("&", 1)[0][:5]
                # 调试用：/asr?engine=whisper 强制走某个引擎做 A/B，不改变默认行为
                want = ""
                if "engine=" in self.path:
                    want = self.path.split("engine=", 1)[1].split("&", 1)[0][:12].lower()
                text = transcribe(body, ext, want)
                return self._json(200, {"text": text, "engine": want or asr_engine_name()})

            if self.path.startswith("/tts"):
                payload = json.loads(body.decode("utf-8"))
                raw = str(payload.get("text") or "").strip()[:1000]
                voice = str(payload.get("voice") or DEFAULT_VOICE)
                # 送进合成前先剥 Markdown：前端不管送什么，念出来都是干净口语
                text = speech_text(raw)
                if not text:
                    return self._json(400, {"error": "text 为空"})
                audio, mime = synth(text, voice)
                if not audio:
                    return self._json(502, {"error": "语音合成无输出"})
                return self._send(200, audio, mime)

            self._json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self._json(500, {"error": str(exc)})


if __name__ == "__main__":
    # 两个引擎并行加载：whisper 只做兜底，SenseVoice 是主力。
    threading.Thread(target=load_sensevoice, daemon=True).start()
    threading.Thread(target=load_model, daemon=True).start()
    # 本地 TTS 首次加载要读 100MB 模型，提前热身，避免第一句话卡住
    threading.Thread(target=local_engine, daemon=True).start()
    print(
        f"[voice] listening 127.0.0.1:{PORT} asr={ASR_ENGINE} whisper={MODEL_SIZE} "
        f"tts={_TTS_ENGINE}",
        flush=True,
    )
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
