package ru.asteria.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.view.Window;
import android.webkit.JavascriptInterface;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

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
    private final Activity activity;

    public WebAppInterface(Activity activity) {
        this.activity = activity;
        this.appContext = activity.getApplicationContext();
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

    /**
     * ФИКС "верх/низ экрана не совпадают с выбранной внутри приложения
     * темой" (например: у пользователя светлая тема чата, а системная
     * панель навигации внизу экрана остаётся чёрной). Раньше цвет
     * статус-бара и панели навигации был жёстко зашит в нативном коде и
     * никогда не менялся — теперь сама веб-страница при каждой смене темы
     * И при открытии/закрытии конкретного чата (см. updateNativeSystemBars()
     * в public/app.js) сообщает сюда РЕАЛЬНЫЙ отрисованный цвет верхней и
     * нижней панели текущего экрана — верхней шапки с именем собеседника
     * (или общего фона в списке чатов) и нижнего поля ввода — и системные
     * панели перекрашиваются под них в реальном времени. Верх и низ могут
     * отличаться друг от друга, поэтому оба цвета передаются раздельно.
     *
     * @param topColorHex      цвет верхней панели, формат "#RRGGBB" (или null/некорректный — не трогаем статус-бар)
     * @param bottomColorHex   цвет нижней панели, формат "#RRGGBB" (или null/некорректный — не трогаем панель навигации)
     * @param topLightIcons    true — значки статус-бара делаем светлыми (тёмный фон сверху)
     * @param bottomLightIcons true — значки панели навигации делаем светлыми (тёмный фон снизу)
     */
    @JavascriptInterface
    public void setSystemBarColors(String topColorHex, String bottomColorHex, boolean topLightIcons, boolean bottomLightIcons) {
        if (activity == null) return;
        Integer topColor = safeParseColor(topColorHex);
        Integer bottomColor = safeParseColor(bottomColorHex);
        if (topColor == null && bottomColor == null) return;
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (window == null) return;
            if (topColor != null) window.setStatusBarColor(topColor);
            if (bottomColor != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                window.setNavigationBarColor(bottomColor);
            }
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                // "lightIcons" в нашем смысле (светлые значки для тёмного
                // фона) — это ИНВЕРСИЯ isAppearanceLightStatusBars/
                // isAppearanceLightNavigationBars ("true" там означает
                // "тёмные значки для светлого фона", а не наоборот).
                if (topColor != null) controller.setAppearanceLightStatusBars(!topLightIcons);
                if (bottomColor != null) controller.setAppearanceLightNavigationBars(!bottomLightIcons);
            }
        });
    }

    private Integer safeParseColor(String hex) {
        if (hex == null) return null;
        try {
            return Color.parseColor(hex);
        } catch (IllegalArgumentException e) {
            return null; // страница прислала что-то не похожее на #RRGGBB — просто игнорируем
        }
    }
}
