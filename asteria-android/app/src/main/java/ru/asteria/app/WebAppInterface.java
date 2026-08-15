package ru.asteria.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.JavascriptInterface;

/**
 * Мост JS -> Android.
 *
 * Раньше здесь же показывалось системное уведомление (show()) — обычный
 * android.webkit.WebView не реализует Web Notifications API, поэтому без
 * этого моста notifyNewMessage() в app.js не мог показать ничего, ни в
 * фоне, ни даже пока страница была открыта.
 *
 * Показ уведомлений теперь полностью взял на себя AsteriaPushService — у
 * него собственное WebSocket-соединение с сервером, которое живёт в
 * foreground-сервисе независимо от того, открыт ли сейчас WebView (и
 * переживает закрытие приложения — то, ради чего раньше был нужен
 * Firebase). Чтобы сервис не показывал уведомление о чате, который
 * пользователь и так смотрит на экране, страница сообщает об этом через
 * setActiveConversation() — см. reportActiveChatToNative() в public/app.js.
 */
public class WebAppInterface {
    private final Context appContext;

    public WebAppInterface(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /**
     * @param conversationId id открытого сейчас чата, либо "" если сейчас
     *                       не в разделе "Чаты" ни в одном конкретном чате.
     */
    @JavascriptInterface
    public void setActiveConversation(String conversationId) {
        AppState.activeConversationId = conversationId == null ? "" : conversationId;
    }

    /**
     * Скачивание фото/видео из чата (кнопка "⬇" в лайтбоксе, см.
     * downloadCurrentLightboxMedia() в public/app.js).
     *
     * Раньше страница сама делала fetch() + blob-URL + клик по
     * <a download>, а WebView.setDownloadListener в MainActivity пытался
     * открыть этот blob: через Intent.ACTION_VIEW — но blob: URL существует
     * только внутри процесса самого WebView, ни одно внешнее приложение
     * (и сам Intent.ACTION_VIEW) открыть его не может. Поэтому скачивание
     * либо тихо ничего не делало, либо падало — и уж точно никогда не
     * попадало в галерею.
     *
     * Теперь страница передаёт сюда НАСТОЯЩУЮ ссылку на сервер, и файл
     * качает системный DownloadManager прямо в публичную папку Pictures
     * (для фото) или Movies (для видео) — без вложенных подпапок: на
     * некоторых устройствах/версиях Android DownloadManager сам не создаёт
     * несуществующую вложенную подпапку и падает с IllegalStateException,
     * из-за чего файл молча не сохранялся вообще. Пишем прямо в корень
     * системной галереи, как и должно быть, с индексацией через
     * allowScanningByMediaScanner(). На API 29+ разрешение на запись не
     * требуется (пишем через MediaStore под капотом), а на более старых —
     * см. requestRuntimePermissions() в MainActivity (WRITE_EXTERNAL_STORAGE).
     */
    @JavascriptInterface
    public void downloadMedia(String url, String filename, String mimeType) {
        try {
            boolean isVideo = mimeType != null && mimeType.startsWith("video/");
            String safeName = (filename == null || filename.isEmpty()) ? ("asteria-" + System.currentTimeMillis()) : filename;
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(safeName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(
                isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES,
                safeName
            );
            request.allowScanningByMediaScanner();
            if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
            DownloadManager dm = (DownloadManager) appContext.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(request);
        } catch (Exception e) {
            // Молча игнорируем: в худшем случае пользователь просто не
            // увидит уведомление о завершении загрузки этого файла.
        }
    }
}
