package ru.asteria.app;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
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
     * ФИКС ("Загрузка начата" и файл так и не появляется): раньше файл качал
     * системный android.app.DownloadManager — отдельный процесс со своим
     * TLS-стеком, который ничего не знает про self-signed/ещё не
     * провалидированный сертификат сервера, даже если пользователь уже
     * согласился ему доверять внутри WebView (см. onReceivedSslError в
     * MainActivity). DownloadManager.enqueue() при этом не бросает ошибку
     * сразу — она проявляется только асинхронно, на самом TLS-рукопожатии,
     * без единого сообщения об ошибке. Подробный разбор — см. FileDownloader.
     */
    @JavascriptInterface
    public void downloadMedia(String url, String filename, String mimeType) {
        boolean isVideo = mimeType != null && mimeType.startsWith("video/");
        String safeName = (filename == null || filename.isEmpty()) ? ("asteria-" + System.currentTimeMillis()) : filename;
        FileDownloader.download(appContext, activity, url, safeName, mimeType, isVideo ? "video" : "image");
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
