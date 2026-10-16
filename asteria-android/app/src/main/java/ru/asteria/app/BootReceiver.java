package ru.asteria.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * После перезагрузки телефона Android не запускает foreground-сервисы сам —
 * без этого приёмника уведомления перестали бы приходить до следующего
 * ручного открытия приложения. Поднимаем AsteriaPushService заново, но
 * только если пользователь уже когда-то подключался к серверу (иначе
 * сервису просто нечего делать — см. проверку в
 * AsteriaPushService.attemptConnect()).
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences("asteria_prefs", Context.MODE_PRIVATE);
        String serverUrl = prefs.getString("server_url", null);
        if (serverUrl == null || serverUrl.isEmpty()) return;
        AsteriaPushService.start(context);
    }
}
