package ru.asteria.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Мост JS -> Android для уведомлений о новых сообщениях.
 *
 * Раньше веб-страница вызывала стандартный window.Notification (Web
 * Notifications API) — но обычный android.webkit.WebView эту API вообще
 * не реализует (window.Notification в нём просто не существует), поэтому
 * notifyNewMessage() в app.js всегда тихо завершался на первой же проверке
 * `!('Notification' in window)` и ни одно уведомление не показывалось —
 * ни в фоне, ни даже пока приложение было открыто. Разрешение
 * POST_NOTIFICATIONS запрашивалось, но нигде не использовалось.
 *
 * Этот класс даёт странице настоящий способ показать системное уведомление
 * Android через NotificationManager. Подключается в MainActivity через
 * webView.addJavascriptInterface(new WebAppInterface(this), "AsteriaNotify"),
 * а app.js вызывает window.AsteriaNotify.show(title, body, conversationId),
 * когда мост доступен (см. notifyNewMessage в public/app.js).
 */
public class WebAppInterface {
    private static final String CHANNEL_ID = "asteria_messages";

    private final Context appContext;

    public WebAppInterface(Context context) {
        this.appContext = context.getApplicationContext();
    }

    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Новые сообщения в чатах Asteria");
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    /**
     * Показывает системное уведомление. tag — id чата: используется и как
     * группирующий ключ (новое сообщение из того же чата заменяет старое
     * уведомление вместо того, чтобы плодить отдельные пуши), и как id
     * разговора, который откроется по тапу.
     */
    @JavascriptInterface
    public void show(String title, String body, String tag) {
        NotificationManager nm = (NotificationManager) appContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        ensureChannel(nm);

        Intent intent = new Intent(appContext, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(MainActivity.EXTRA_OPEN_CONVERSATION_ID, tag);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        int reqCode = tag == null ? 0 : tag.hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(appContext, reqCode, intent, piFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE);

        try {
            NotificationManagerCompat.from(appContext).notify(tag, reqCode, builder.build());
        } catch (SecurityException e) {
            // Пользователь не выдал POST_NOTIFICATIONS (Android 13+) — молча пропускаем,
            // как и обычный браузерный Notification API вёл бы себя без разрешения.
        }
    }
}
