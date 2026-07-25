package ru.asteria.app;

import android.content.Context;
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
}
