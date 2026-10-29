package com.qinghe.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 拍照落盘用的文件提供者：系统相机把照片写进应用 cache/shots，
 * 壳再把同一个 content:// 交给 WebView 的文件上传通道。
 * Android 7+ 禁止以 file:// 跨应用传文件，所以这里必须是 content:// URI。
 */
public class ShotProvider extends ContentProvider {

    public static final String AUTHORITY = "com.qinghe.app.shot";

    /** 相机输出目录：随 cache 走，系统空间紧张时可以被回收 */
    public static File dirFor(Context ctx) {
        File d = new File(ctx.getCacheDir(), "shots");
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    public static Uri uriFor(Context ctx, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("非法文件名");
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("无上下文");
        File base = dirFor(ctx);
        File f = new File(base, name);
        try {
            // 防止路径穿越
            if (!f.getCanonicalPath().startsWith(base.getCanonicalPath() + File.separator)) {
                throw new FileNotFoundException("路径越界");
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径校验失败");
        }
        // 相机应用多以 "w"/"rwt" 打开输出 Uri，必须按 mode 给写权限，否则拍照失败
        int flags = "r".equals(mode)
                ? ParcelFileDescriptor.MODE_READ_ONLY
                : ParcelFileDescriptor.MODE_CREATE
                | ParcelFileDescriptor.MODE_TRUNCATE
                | ParcelFileDescriptor.MODE_WRITE_ONLY;
        return ParcelFileDescriptor.open(f, flags);
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
