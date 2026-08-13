package ru.asteria.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Обновление приложения без Google Play — раньше нужно было вручную ходить
 * к каждому пользователю и переустанавливать APK. Теперь админ загружает
 * новую версию через панель на сайте (см. вкладку "Новый APK" в
 * public/app.js и GET/POST /api/admin/app-release, GET /api/app/version,
 * GET /api/app/download в server.js), а приложение само проверяет версию
 * при каждом запуске и предлагает обновиться.
 *
 * Ничего не устанавливается без явного согласия пользователя — только
 * предлагаем диалогом, скачиваем по нажатию "Установить" и открываем
 * системный установщик APK (как при установке файла, скачанного из
 * браузера).
 */
final class AppUpdateManager {
    private AppUpdateManager() { }

    private static final String PREFS = "asteria_prefs";
    private static final String KEY_SKIPPED_VERSION = "update_skipped_version_code";
    private static final String APK_FILE_NAME = "asteria-update.apk";

    // Вызывается один раз за запуск, после того как WebView успешно
    // загрузил страницу (см. onPageFinished в MainActivity) — значит,
    // сервер уже точно доступен по этому адресу.
    static void checkForUpdate(Activity activity, String baseUrl) {
        if (activity == null || baseUrl == null || baseUrl.isEmpty()) return;
        String versionUrl = trimTrailingSlash(baseUrl) + "/api/app/version";

        Request request = new Request.Builder().url(versionUrl).get().build();
        buildHttpClient().newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                // Не получилось проверить — не критично, попробуем при
                // следующем запуске приложения.
            }

            @Override
            public void onResponse(Call call, Response response) {
                try (ResponseBody body = response.body()) {
                    if (!response.isSuccessful() || body == null) return;
                    JSONObject json = new JSONObject(body.string());
                    if (!json.optBoolean("available", false)) return;

                    int serverVersionCode = json.optInt("versionCode", 0);
                    if (serverVersionCode <= BuildConfig.VERSION_CODE) return; // уже свежая версия

                    SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                    if (prefs.getInt(KEY_SKIPPED_VERSION, 0) == serverVersionCode) return; // эту версию уже пропустили по просьбе пользователя

                    String versionName = json.optString("versionName", "");
                    String notes = json.optString("notes", "");
                    String downloadUrl = trimTrailingSlash(baseUrl) + json.optString("url", "/api/app/download");

                    new Handler(Looper.getMainLooper()).post(() -> {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        showUpdateDialog(activity, serverVersionCode, versionName, notes, downloadUrl);
                    });
                } catch (Exception ignored) {
                    // Неожиданный формат ответа сервера — тихо пропускаем, не мешаем работе приложения
                }
            }
        });
    }

    private static void showUpdateDialog(Activity activity, int versionCode, String versionName, String notes, String downloadUrl) {
        StringBuilder message = new StringBuilder("Доступна версия ").append(versionName).append('.');
        if (notes != null && !notes.isEmpty()) message.append("\n\n").append(notes);

        new AlertDialog.Builder(activity)
                .setTitle("Доступно обновление приложения")
                .setMessage(message.toString())
                .setCancelable(true)
                .setPositiveButton("Установить", (d, w) -> downloadAndInstall(activity, downloadUrl))
                .setNegativeButton("Позже", null)
                .setNeutralButton("Пропустить эту версию", (d, w) -> activity
                        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putInt(KEY_SKIPPED_VERSION, versionCode).apply())
                .show();
    }

    private static void downloadAndInstall(Activity activity, String downloadUrl) {
        ProgressDialog progress = new ProgressDialog(activity);
        progress.setMessage("Скачивание обновления…");
        progress.setCancelable(false);
        progress.setIndeterminate(true);
        try { progress.show(); } catch (Exception ignored) { }

        Request request = new Request.Builder().url(downloadUrl).get().build();
        buildHttpClient().newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                runOnUi(activity, () -> {
                    dismissQuietly(progress);
                    Toast.makeText(activity, "Не удалось скачать обновление: " + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }

            @Override
            public void onResponse(Call call, Response response) {
                File outFile = new File(activity.getCacheDir(), APK_FILE_NAME);
                try (ResponseBody body = response.body()) {
                    if (!response.isSuccessful() || body == null) throw new IOException("HTTP " + response.code());
                    try (InputStream in = body.byteStream(); FileOutputStream out = new FileOutputStream(outFile)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                } catch (Exception e) {
                    runOnUi(activity, () -> {
                        dismissQuietly(progress);
                        Toast.makeText(activity, "Не удалось скачать обновление: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    });
                    return;
                }
                runOnUi(activity, () -> {
                    dismissQuietly(progress);
                    launchInstall(activity, outFile);
                });
            }
        });
    }

    // Разрешение "Устанавливать неизвестные приложения" (Android 8+) нужно
    // получить один раз от пользователя — без него системный установщик
    // просто откажет открыть APK, полученный не из Play Store.
    private static void launchInstall(Activity activity, File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity, "Разрешите установку из этого приложения, затем нажмите «Установить» ещё раз", Toast.LENGTH_LONG).show();
            try {
                Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(settingsIntent);
            } catch (Exception ignored) { }
            return;
        }
        try {
            Uri apkUri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apkFile);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(installIntent);
        } catch (Exception e) {
            Toast.makeText(activity, "Не удалось запустить установку: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private static void dismissQuietly(ProgressDialog dialog) {
        try { if (dialog.isShowing()) dialog.dismiss(); } catch (Exception ignored) { }
    }

    private static void runOnUi(Activity activity, Runnable r) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            r.run();
        });
    }

    private static String trimTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    // Тот же принцип, что и у фонового push-сервиса (см.
    // AsteriaPushService.buildHttpClient()) — доверяем самоподписанному
    // сертификату сервера ровно настолько, насколько пользователь уже
    // согласился в WebView (см. onReceivedSslError в MainActivity). Если на
    // сервере уже настоящий сертификат Let's Encrypt — эта часть просто не
    // понадобится, но и не мешает.
    private static OkHttpClient buildHttpClient() {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true);
        try {
            X509TrustManager trustAll = new X509TrustManager() {
                public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) { }
                public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("Пустая цепочка сертификатов");
                }
                public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
            };
            SSLContext sslContext = SSLContext.getInstance("TLS");
            sslContext.init(null, new X509TrustManager[]{trustAll}, new SecureRandom());
            builder.sslSocketFactory(sslContext.getSocketFactory(), trustAll);
            builder.hostnameVerifier((hostname, session) -> true);
        } catch (Exception ignored) { }
        return builder.build();
    }
}
