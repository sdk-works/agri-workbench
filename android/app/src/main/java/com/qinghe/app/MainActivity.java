package com.qinghe.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;

/**
 * 京阳智农 —— WebView 壳。
 * 页面统一走云端（42.193.104.148:8080），网页更新后无需重装 APK；
 * 仅壳本身升级时，通过 /apk/agri-android.json 检测并在线安装。
 */
public class MainActivity extends Activity {

    private static final String TAG = "QingHeApp";
    private static final String HOME_URL = "http://42.193.104.148:8080/";
    private static final String HOME_HOST = "42.193.104.148";
    private static final String UPDATE_URL = "http://42.193.104.148/apk/agri-android.json";
    private static final int FILE_CHOOSER_RESULT_CODE = 100;
    private static final int MIC_PERMISSION_CODE = 200;
    private static final String APK_NAME = "jingyang-update.apk";

    private WebView web;
    private ValueCallback<Uri[]> uploadMessage;
    private long downloadId = -1L;
    private long lastUpdateCheck = 0L;
    private int lastPromptedCode = 0;
    private long lastPromptAt = 0L;
    private String pendingApkName = APK_NAME;
    private BroadcastReceiver downloadReceiver;

    // 语音通话
    private SpeechRecognizer speech;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private boolean startListeningAfterPermission = false;

    // 原生录音（HTTP 页面无法用 getUserMedia，改由壳录音后交给网页上传）
    private MediaRecorder recorder;
    private File recFile;
    private final Handler ampHandler = new Handler(Looper.getMainLooper());
    private boolean recActive = false;
    private boolean recHeard = false;
    private long recSilenceStart = 0;
    private long recStartedAt = 0;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        FrameLayout frame = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(0xFFF7F8FA);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 移动端正确缩放（否则按 980px 虚拟宽度渲染，右侧会被裁掉）
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                // 站内页面留在 WebView，外部链接交给系统浏览器
                if (url.startsWith("http://" + HOME_HOST)
                        || url.startsWith("https://" + HOME_HOST)
                        || url.startsWith("http://qinghe.local")
                        || url.startsWith("about:")) {
                    view.loadUrl(url);
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面就绪后再查一次更新，避免冷启动抢占带宽
                maybeCheckUpdate(false);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 网页 getUserMedia 录音需要壳放行
                runOnUiThread(() -> {
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                            request.grant(new String[]{res});
                            return;
                        }
                    }
                    request.deny();
                });
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams params) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_RESULT_CODE);
                } catch (ActivityNotFoundException e) {
                    uploadMessage = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, android.webkit.JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }
        });

        setContentView(root);
        root.addView(web, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        registerDownloadReceiver();
        initVoice();
        web.loadUrl(HOME_URL);
        maybeCheckUpdate(false);
    }

    // ───────────────────────── 在线更新 ─────────────────────────

    /** 每次回到前台都检查（60 秒节流），避免进程常驻时永远看不到新版本 */
    private void maybeCheckUpdate(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastUpdateCheck < 60_000L) return;
        lastUpdateCheck = now;
        new Thread(this::doCheckUpdate, "ota-check").start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeCheckUpdate(false);
    }

    private void doCheckUpdate() {
        HttpURLConnection conn = null;
        try {
            // 加时间戳，绕过任何中间缓存
            String manifestUrl = UPDATE_URL + "?t=" + System.currentTimeMillis();
            conn = (HttpURLConnection) new URL(manifestUrl).openConnection();
            conn.setUseCaches(false);
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            conn.setRequestProperty("Cache-Control", "no-cache, no-store");
            conn.setRequestProperty("Pragma", "no-cache");
            conn.setRequestProperty("User-Agent", "QingHeAndroid/" + versionName());
            if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) return;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }

            JSONObject o = new JSONObject(sb.toString());
            int remoteCode = o.optInt("versionCode", 0);
            if (remoteCode <= versionCode()) return;

            String remoteName = o.optString("versionName", String.valueOf(remoteCode));
            String apkUrl = o.optString("apkUrl", "");
            boolean force = o.optBoolean("force", false);
            if (apkUrl.isEmpty()) return;

            StringBuilder changes = new StringBuilder();
            JSONArray arr = o.optJSONArray("changelog");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    changes.append("· ").append(arr.optString(i)).append('\n');
                }
            }

            final String name = remoteName;
            final String log = changes.toString().trim();
            final String url = apkUrl;
            final int code = remoteCode;
            runOnUiThread(() -> showUpdateDialog(name, log, url, force, code));
        } catch (Exception e) {
            Log.w(TAG, "更新检查失败", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void showUpdateDialog(String version, String changelog, String apkUrl, boolean force, int versionCode) {
        if (isFinishing()) return;
        long now = System.currentTimeMillis();
        // 同一版本 10 分钟内不重复打扰
        if (!force && versionCode == lastPromptedCode && now - lastPromptAt < 600_000L) return;
        lastPromptedCode = versionCode;
        lastPromptAt = now;
        String msg = (changelog.isEmpty() ? "发现新版本，建议立即更新。" : changelog)
                + "\n\n当前版本：" + versionName();
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("发现新版本 v" + version)
                .setMessage(msg)
                .setPositiveButton("立即更新", (d, w) -> downloadApk(apkUrl, versionCode))
                .setCancelable(!force);
        if (!force) {
            b.setNegativeButton("稍后", (d, w) -> {
            });
        }
        b.show();
    }

    private void downloadApk(String apkUrl, int versionCode) {
        try {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) {
                Toast.makeText(this, "存储不可用", Toast.LENGTH_SHORT).show();
                return;
            }
            // 清掉历史更新包，避免把旧版本装回去
            File[] olds = dir.listFiles((d, n) -> n.startsWith("jingyang-update"));
            if (olds != null) {
                for (File f : olds) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
            pendingApkName = "jingyang-update-" + versionCode + ".apk";
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("京阳智农 更新包");
            req.setDescription("正在下载新版本…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setAllowedOverMetered(true);
            req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, pendingApkName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            downloadId = dm.enqueue(req);
            Toast.makeText(this, "开始下载更新包…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "下载失败", e);
            Toast.makeText(this, "下载失败，请稍后重试", Toast.LENGTH_SHORT).show();
        }
    }

    private void registerDownloadReceiver() {
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != downloadId) return;
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
                try (Cursor c = dm.query(q)) {
                    if (c != null && c.moveToFirst()) {
                        int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                            installApk(new File(dir, pendingApkName));
                        } else {
                            Toast.makeText(MainActivity.this, "更新包下载失败", Toast.LENGTH_SHORT).show();
                        }
                    }
                }
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, f, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, f);
        }
    }

    private void installApk(File apk) {
        if (apk == null || !apk.exists()) {
            Toast.makeText(this, "更新包不存在", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(this)
                    .setTitle("需要安装权限")
                    .setMessage("请允许「京阳智农」安装未知来源应用后，再回到应用完成更新。")
                    .setPositiveButton("去设置", (d, w) -> {
                        try {
                            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName())));
                        } catch (Exception ignored) {
                        }
                    })
                    .setNegativeButton("取消", null)
                    .show();
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(ApkFileProvider.uriFor(this, apk), "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "无法启动安装程序", Toast.LENGTH_SHORT).show();
        }
    }

    private int versionCode() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String versionName() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionName == null ? "0" : p.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    // ───────────────────────── 语音通话 ─────────────────────────

    private void initVoice() {
        // 暴露给网页：window.QingHeVoice
        web.addJavascriptInterface(new VoiceBridge(), "QingHeVoice");

        try {
            tts = new TextToSpeech(this, status -> {
                if (status != TextToSpeech.SUCCESS || tts == null) return;
                int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA
                        && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {
                    }

                    @Override
                    public void onDone(String utteranceId) {
                        emitVoiceEvent("speakEnd", null, null);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        emitVoiceEvent("speakEnd", null, null);
                    }
                });
            });
        } catch (Exception e) {
            Log.w(TAG, "TTS 初始化失败", e);
        }

        if (SpeechRecognizer.isRecognitionAvailable(this)) {
            speech = SpeechRecognizer.createSpeechRecognizer(this);
            speech.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                }

                @Override
                public void onBeginningOfSpeech() {
                }

                @Override
                public void onRmsChanged(float rmsdB) {
                }

                @Override
                public void onBufferReceived(byte[] buffer) {
                }

                @Override
                public void onEndOfSpeech() {
                }

                @Override
                public void onError(int error) {
                    emitVoiceEvent("error", null, recognitionError(error));
                }

                @Override
                public void onResults(Bundle results) {
                    String text = firstResult(results);
                    if (text.isEmpty()) {
                        emitVoiceEvent("error", null, "没有听清，请再说一次");
                    } else {
                        emitVoiceEvent("result", text, null);
                    }
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    String text = firstResult(partialResults);
                    if (!text.isEmpty()) emitVoiceEvent("partial", text, null);
                }

                @Override
                public void onEvent(int eventType, Bundle params) {
                }
            });
        }
    }

    private String firstResult(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty() || list.get(0) == null) return "";
        return list.get(0).trim();
    }

    private String recognitionError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "录音出错";
            case SpeechRecognizer.ERROR_CLIENT:
                return "识别客户端出错";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "麦克风权限被拒绝";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "语音服务网络异常";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没有听清，请再说一次";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "识别服务忙，请稍后再试";
            case SpeechRecognizer.ERROR_SERVER:
                return "语音服务器出错";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "没有检测到说话";
            default:
                return "语音识别失败";
        }
    }

    private void emitVoiceEvent(String type, String text, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (message != null) o.put("message", message);
            final String js = "window.__qingheVoice && window.__qingheVoice(" + o + ")";
            runOnUiThread(() -> {
                if (web != null) web.evaluateJavascript(js, null);
            });
        } catch (Exception e) {
            Log.w(TAG, "语音事件发送失败", e);
        }
    }

    private void startRecognition() {
        if (speech == null) {
            emitVoiceEvent("error", null, "此手机未提供语音识别服务");
            return;
        }
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            startListeningAfterPermission = true;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_PERMISSION_CODE);
            return;
        }
        try {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN");
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            speech.startListening(i);
        } catch (Exception e) {
            emitVoiceEvent("error", null, "无法启动语音识别");
        }
    }

    private void stopRecognition() {
        try {
            if (speech != null) speech.stopListening();
        } catch (Exception ignored) {
        }
    }

    private void speakText(String text) {
        if (text == null || text.trim().isEmpty()) {
            emitVoiceEvent("speakEnd", null, null);
            return;
        }
        if (tts == null) {
            emitVoiceEvent("error", null, "此手机未提供语音朗读服务");
            return;
        }
        if (!ttsReady) {
            emitVoiceEvent("error", null, "中文朗读引擎不可用");
            return;
        }
        try {
            tts.stop();
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null,
                    "qinghe-" + System.currentTimeMillis());
        } catch (Exception e) {
            emitVoiceEvent("speakEnd", null, null);
        }
    }

    private void stopSpeaking() {
        try {
            if (tts != null) tts.stop();
        } catch (Exception ignored) {
        }
    }

    /** 网页通过 window.QingHeVoice 调用（运行在 JS 线程，需切回主线程） */
    public class VoiceBridge {
        @JavascriptInterface
        public String available() {
            return (speech != null || tts != null) ? "1" : "0";
        }

        /** 返回能力诊断，供网页展示具体的权限/服务指引 */
        @JavascriptInterface
        public String diagnose() {
            try {
                JSONObject o = new JSONObject();
                o.put("bridge", 1);
                o.put("asr", speech != null);
                o.put("tts", tts != null && ttsReady);
                boolean granted = Build.VERSION.SDK_INT < 23
                        || checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED;
                o.put("mic", granted ? "granted" : "denied");
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("asrService", SpeechRecognizer.isRecognitionAvailable(MainActivity.this));
                o.put("rec", true);
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void requestMic() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 23) {
                    startListeningAfterPermission = false;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                            MIC_PERMISSION_CODE);
                }
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void checkUpdate() {
            runOnUiThread(() -> maybeCheckUpdate(true));
        }

        @JavascriptInterface
        public void recStart() {
            runOnUiThread(() -> startRec());
        }

        @JavascriptInterface
        public void recStop() {
            runOnUiThread(() -> stopRec(true));
        }

        @JavascriptInterface
        public void recCancel() {
            runOnUiThread(() -> cancelRec());
        }

        @JavascriptInterface
        public void startListening() {
            runOnUiThread(MainActivity.this::startRecognition);
        }

        @JavascriptInterface
        public void stopListening() {
            runOnUiThread(MainActivity.this::stopRecognition);
        }

        @JavascriptInterface
        public void speak(String text) {
            runOnUiThread(() -> speakText(text));
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(MainActivity.this::stopSpeaking);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MIC_PERMISSION_CODE) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && startListeningAfterPermission) {
                startListeningAfterPermission = false;
                startRecognition();
            } else if (!granted) {
                emitVoiceEvent("error", null, "麦克风权限被拒绝，请在系统设置中允许");
            }
        }
    }

    // ───────────────────── 原生录音（供网页语音上传）─────────────────────

    private boolean hasMicPermission() {
        return Build.VERSION.SDK_INT < 23
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void startRec() {
        if (!hasMicPermission()) {
            startListeningAfterPermission = false;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                    MIC_PERMISSION_CODE);
            emitVoiceEvent("error", null, "需要麦克风权限，请在弹窗中允许");
            return;
        }
        try {
            stopRec(false);
            File dir = getCacheDir();
            recFile = new File(dir, "voice-input.m4a");
            if (recFile.exists() && !recFile.delete()) {
                Log.w(TAG, "旧录音删除失败");
            }
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioChannels(1);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setOutputFile(recFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            recActive = true;
            recHeard = false;
            recSilenceStart = 0;
            recStartedAt = System.currentTimeMillis();
            ampHandler.postDelayed(ampTick, 120);
        } catch (Exception e) {
            Log.w(TAG, "录音启动失败", e);
            recActive = false;
            emitVoiceEvent("error", null, "无法启动录音：" + e.getMessage());
        }
    }

    private final Runnable ampTick = new Runnable() {
        @Override
        public void run() {
            if (!recActive || recorder == null) return;
            int amp = 0;
            try {
                if (Build.VERSION.SDK_INT >= 24) amp = recorder.getMaxAmplitude();
            } catch (Exception ignored) {
            }
            long now = System.currentTimeMillis();
            if (amp > 1200) {
                recHeard = true;
                recSilenceStart = 0;
            } else if (recHeard) {
                if (recSilenceStart == 0) recSilenceStart = now;
                else if (now - recSilenceStart > 900) {
                    stopRec(true);
                    return;
                }
            }
            long limit = Build.VERSION.SDK_INT >= 24 ? 15000 : 8000;
            if (now - recStartedAt > limit) {
                stopRec(true);
                return;
            }
            ampHandler.postDelayed(this, 100);
        }
    };

    private void stopRec(boolean deliver) {
        if (!recActive) return;
        recActive = false;
        ampHandler.removeCallbacks(ampTick);
        try {
            recorder.stop();
        } catch (Exception ignored) {
        }
        try {
            recorder.release();
        } catch (Exception ignored) {
        }
        recorder = null;
        if (!deliver || recFile == null) return;
        try {
            byte[] data = readAll(recFile);
            if (data.length < 1500) {
                emitVoiceEvent("error", null, "没有听清，请再说一次");
                return;
            }
            String b64 = Base64.encodeToString(data, Base64.NO_WRAP);
            emitVoiceAudio(b64, "m4a");
        } catch (Exception e) {
            Log.w(TAG, "读取录音失败", e);
            emitVoiceEvent("error", null, "读取录音失败");
        }
    }

    private void cancelRec() {
        if (!recActive) return;
        recActive = false;
        ampHandler.removeCallbacks(ampTick);
        try {
            recorder.stop();
        } catch (Exception ignored) {
        }
        try {
            recorder.release();
        } catch (Exception ignored) {
        }
        recorder = null;
    }

    private byte[] readAll(File file) throws Exception {
        try (FileInputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private void emitVoiceAudio(String data, String ext) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "audio");
            o.put("ext", ext);
            o.put("data", data);
            final String js = "window.__qingheVoice && window.__qingheVoice(" + o + ")";
            runOnUiThread(() -> {
                if (web != null) web.evaluateJavascript(js, null);
            });
        } catch (Exception e) {
            Log.w(TAG, "录音回传失败", e);
        }
    }

    // ───────────────────────── 生命周期 ─────────────────────────

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (uploadMessage == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                ClipData clip = data.getClipData();
                if (clip != null) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) {
            try {
                unregisterReceiver(downloadReceiver);
            } catch (Exception ignored) {
            }
            downloadReceiver = null;
        }
        try {
            if (speech != null) {
                speech.destroy();
                speech = null;
            }
        } catch (Exception ignored) {
        }
        try {
            cancelRec();
        } catch (Exception ignored) {
        }
        try {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
                tts = null;
            }
        } catch (Exception ignored) {
        }
        if (web != null) {
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
