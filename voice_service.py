#!/usr/bin/env python3
"""本地语音服务：faster-whisper 识别 + edge-tts 合成。

仅监听 127.0.0.1，由 Node 后端反代。
    GET  /health          -> {"ok":true,"asr":true/false,"asrError":...}
    POST /asr?ext=webm    -> 原始音频字节，返回 {"text":"..."}
    POST /tts             -> {"text":"...","voice":"zh-CN-XiaoxiaoNeural"}，返回 audio/mpeg
"""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import threading
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

_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u2190-\u21FF\u2B00-\u2BFF]"
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

_model = None
_model_error = None


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


def transcribe(data: bytes, ext: str) -> str:
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
        for wrong, right in ASR_TERM_FIX:
            text = text.replace(wrong, right)
        return text
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def synth(text: str, voice: str) -> bytes:
    key = hashlib.sha1((voice + "\n" + text).encode("utf-8")).hexdigest()
    path = os.path.join(CACHE_DIR, key + ".mp3")
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read()

    import edge_tts

    async def run() -> bytes:
        buf = bytearray()
        async for chunk in edge_tts.Communicate(text, voice).stream():
            if chunk.get("type") == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    data = asyncio.run(run())
    if data:
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    return data


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
                "asr": _model is not None,
                "asrError": _model_error,
                "tts": True,
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
                text = transcribe(body, ext)
                return self._json(200, {"text": text})

            if self.path.startswith("/tts"):
                payload = json.loads(body.decode("utf-8"))
                raw = str(payload.get("text") or "").strip()[:1000]
                voice = str(payload.get("voice") or DEFAULT_VOICE)
                # 送进合成前先剥 Markdown：前端不管送什么，念出来都是干净口语
                text = speech_text(raw)
                if not text:
                    return self._json(400, {"error": "text 为空"})
                audio = synth(text, voice)
                if not audio:
                    return self._json(502, {"error": "语音合成无输出"})
                return self._send(200, audio, "audio/mpeg")

            self._json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            self._json(500, {"error": str(exc)})


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    print(f"[voice] listening 127.0.0.1:{PORT} model={MODEL_SIZE}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
