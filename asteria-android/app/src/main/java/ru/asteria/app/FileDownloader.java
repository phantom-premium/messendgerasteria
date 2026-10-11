package ru.asteria.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Общая логика скачивания файлов (фото/видео из лайтбокса — см.
 * WebAppInterface.downloadMedia — и обычных файлов из чата — см.
 * MainActivity.setDownloadListener), заменяющая собой системный
 * DownloadManager.
 *
 * БАГ, который чинит этот класс ("Пишет загрузка начата и не грузит"):
 * сервер этого мессенджера — самостоятельно хостится, и у части
 * администраторов на нём self-signed (или временно "ещё не начал
 * действовать" из-за рассинхрона часов) сертификат. WebView прекрасно с
 * этим справляется — см. MainActivity.onReceivedSslError, там пользователь
 * явно соглашается доверять такому сертификату, и вся веб-страница
 * (картинки, видео, звонки) после этого работает нормально. Раньше же
 * ЗАГРУЗКА файлов делалась через системный android.app.DownloadManager — а
 * это ОТДЕЛЬНЫЙ процесс со своим собственным TLS-стеком, который ничего не
 * знает о том, что пользователь только что согласился доверять этому
 * серверу внутри WebView. DownloadManager.enqueue() при этом не бросает
 * ошибку сразу (сама постановка в очередь всегда успешна — отсюда
 * "Загрузка начата"), а настоящая попытка скачать файл проваливается уже
 * асинхронно, на TLS-рукопожатии — без единого сообщения об ошибке,
 * которое бы увидел пользователь.
 *
 * Чиним, скачивая файл САМИ, с тем же уровнем доверия к сертификату,
 * который пользователь уже дал WebView (доверяем ровно тому же серверу, а
 * не "всему интернету" — соединения устанавливаются только с адресом,
 * который сама открытая страница и передаёт).
 */
final class FileDownloader {
    private FileDownloader() {}

    private static volatile SSLSocketFactory permissiveSslSocketFactory;

    private static SSLSocketFactory permissiveSslSocketFactory() throws Exception {
        if (permissiveSslSocketFactory == null) {
            synchronized (FileDownloader.class) {
                if (permissiveSslSocketFactory == null) {
                    TrustManager[] trustAll = new TrustManager[]{new X509TrustManager() {
                        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                        @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    }};
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, trustAll, new SecureRandom());
                    permissiveSslSocketFactory = ctx.getSocketFactory();
                }
            }
        }
        return permissiveSslSocketFactory;
    }

    /**
     * @param kind "image" / "video" / любое другое значение — воспринимается
     *             как обычный файл (сохраняется в Загрузки).
     */
    static void download(Context appContext, Activity activity, String url, String filename, String mimeType, String kind) {
        new Thread(() -> {
            try {
                URL u = new URL(url);
                HttpURLConnection conn = (HttpURLConnection) u.openConnection();
                if (conn instanceof HttpsURLConnection) {
                    HttpsURLConnection https = (HttpsURLConnection) conn;
                    https.setSSLSocketFactory(permissiveSslSocketFactory());
                    https.setHostnameVerifier((hostname, session) -> true);
                }
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new IOException("Сервер ответил " + code);
                String resolvedMime = (mimeType != null && !mimeType.isEmpty())
                        ? mimeType
                        : guessMimeType(filename);
                try (InputStream in = conn.getInputStream()) {
                    saveToPublicStorage(appContext, in, filename, resolvedMime, kind);
                }
                activity.runOnUiThread(() ->
                        Toast.makeText(appContext, "Сохранено: " + filename, Toast.LENGTH_SHORT).show());
            } catch (Exception e) {
                // Раньше ошибка молча проглатывалась (или терялась где-то в
                // недрах DownloadManager) — теперь человек явно видит, что
                // именно пошло не так, вместо вечно висящей "загрузки".
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                activity.runOnUiThread(() ->
                        Toast.makeText(appContext, "Не удалось скачать файл: " + msg, Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private static String guessMimeType(String filename) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(filename);
        if (ext == null || ext.isEmpty()) return "application/octet-stream";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return type != null ? type : "application/octet-stream";
    }

    private static void saveToPublicStorage(Context appContext, InputStream in, String filename, String mimeType, String kind) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Scoped storage (API 29+): пишем через MediaStore, без
            // WRITE_EXTERNAL_STORAGE — так же, как раньше (по замыслу)
            // делал сам DownloadManager "под капотом".
            Uri collection;
            String relativeDir;
            if ("image".equals(kind)) {
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                relativeDir = Environment.DIRECTORY_PICTURES;
            } else if ("video".equals(kind)) {
                collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                relativeDir = Environment.DIRECTORY_MOVIES;
            } else {
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                relativeDir = Environment.DIRECTORY_DOWNLOADS;
            }
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDir);
            ContentResolver resolver = appContext.getContentResolver();
            Uri itemUri = resolver.insert(collection, values);
            if (itemUri == null) throw new IOException("Не удалось создать файл в хранилище");
            try (OutputStream out = resolver.openOutputStream(itemUri)) {
                if (out == null) throw new IOException("Не удалось открыть файл для записи");
                copy(in, out);
            }
        } else {
            // Android 9 и старше: обычная запись в публичную папку (уже
            // объявленное разрешение WRITE_EXTERNAL_STORAGE, maxSdkVersion=28).
            String dirType = "image".equals(kind) ? Environment.DIRECTORY_PICTURES
                    : "video".equals(kind) ? Environment.DIRECTORY_MOVIES
                    : Environment.DIRECTORY_DOWNLOADS;
            File destDir = Environment.getExternalStoragePublicDirectory(dirType);
            if (!destDir.exists()) destDir.mkdirs();
            File destFile = new File(destDir, filename);
            try (FileOutputStream out = new FileOutputStream(destFile)) {
                copy(in, out);
            }
            MediaScannerConnection.scanFile(appContext, new String[]{destFile.getAbsolutePath()}, new String[]{mimeType}, null);
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
}
