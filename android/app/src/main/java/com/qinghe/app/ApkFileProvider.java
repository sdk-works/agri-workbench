package com.qinghe.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 APK 文件提供者：把下载目录里的更新包以 content:// 暴露给系统安装器。
 * 用途：Android 7+ 禁止 file:// 跨应用传递，必须有 content:// URI。
 * 仅授予临时读权限（FLAG_GRANT_READ_URI_PERMISSION），不对外导出。
 */
public class ApkFileProvider extends ContentProvider {

    public static final String AUTHORITY = "com.qinghe.app.apk";

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
        if (getContext() == null) throw new FileNotFoundException("无上下文");
        File base = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (base == null) throw new FileNotFoundException("下载目录不可用");
        File f = new File(base, name);
        try {
            // 防止路径穿越
            if (!f.getCanonicalPath().startsWith(base.getCanonicalPath() + File.separator)) {
                throw new FileNotFoundException("路径越界");
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径校验失败");
        }
        if (!f.exists()) throw new FileNotFoundException("文件不存在");
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
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
