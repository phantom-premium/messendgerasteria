package ru.asteria.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Управление кешем приложения (раздел «Настройки → Данные и память»).
 *
 * Что считается кешем:
 *  - HTTP-кеш WebView (картинки, видео, голосовые, скрипты) и временные файлы
 *    в cacheDir / externalCacheDir (в т. ч. скачанный APK обновления);
 *  - офлайн-копия чатов в IndexedDB — её считает и чистит сама страница
 *    (OfflineStore в offline.js), здесь она не трогается.
 *
 * Что НЕ трогается никогда: куки сессии (вход в аккаунт), localStorage,
 * ключи AirPin (filesDir) и скачанные пользователем файлы в «Загрузках».
 *
 * Лимит кеша: пользователь выбирает размер в МБ (0 — без ограничения). Если на
 * старте приложения кеш больше лимита, он очищается целиком.
 */
final class CacheManager {
    private static final String PREFS = "asteria_prefs";
    private static final String KEY_LIMIT_MB = "cache_limit_mb";

    private CacheManager() {}

    static long sizeOf(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        File[] kids = f.listFiles();
        if (kids == null) return 0;
        long sum = 0;
        for (File k : kids) sum += sizeOf(k);
        return sum;
    }

    private static void deleteChildren(File dir) {
        if (dir == null || !dir.isDirectory()) return;
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File k : kids) deleteRecursive(k);
    }

    private static void deleteRecursive(File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        // Ошибку удаления игнорируем: файл мог быть занят — в следующий раз уйдёт.
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    static long cacheBytes(Context ctx) {
        long total = sizeOf(ctx.getCacheDir());
        File ext = ctx.getExternalCacheDir();
        if (ext != null) total += sizeOf(ext);
        return total;
    }

    static int getLimitMb(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_LIMIT_MB, 0);
    }

    static void setLimitMb(Context ctx, int mb) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putInt(KEY_LIMIT_MB, Math.max(0, mb)).apply();
    }

    /** JSON для страницы: {"cacheBytes":123,"limitMb":0}. */
    static String infoJson(Context ctx) {
        try {
            JSONObject o = new JSONObject();
            o.put("cacheBytes", cacheBytes(ctx));
            o.put("limitMb", getLimitMb(ctx));
            return o.toString();
        } catch (Exception e) {
            return "{\"cacheBytes\":0,\"limitMb\":0}";
        }
    }

    /**
     * Очищает кеш. Вызывать можно с любого потока: чистка WebView уходит в UI-поток,
     * файлы удаляются на вызывающем. Возвращает, сколько байт освободилось.
     */
    static long clear(Activity activity) {
        Context ctx = activity.getApplicationContext();
        long before = cacheBytes(ctx);
        final CountDownLatch done = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                WebView w = activity.findViewById(R.id.webView);
                if (w != null) w.clearCache(true); // true — и дисковый кеш
            } catch (Throwable ignored) {
            } finally {
                done.countDown();
            }
        });
        try { done.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        deleteChildren(ctx.getCacheDir());
        File ext = ctx.getExternalCacheDir();
        if (ext != null) deleteChildren(ext);
        long after = cacheBytes(ctx);
        return Math.max(0, before - after);
    }

    /**
     * Вызывается в самом начале MainActivity.onCreate — до создания WebView, пока его дисковый
     * кеш ещё никто не открыл, поэтому файлы можно удалять безопасно. Кеш больше лимита — чистим.
     */
    static void enforceLimit(Context ctx) {
        final Context app = ctx.getApplicationContext();
        final int limit = getLimitMb(app);
        if (limit <= 0) return;
        if (cacheBytes(app) > (long) limit * 1024L * 1024L) {
            deleteChildren(app.getCacheDir());
            File ext = app.getExternalCacheDir();
            if (ext != null) deleteChildren(ext);
        }
    }
}
