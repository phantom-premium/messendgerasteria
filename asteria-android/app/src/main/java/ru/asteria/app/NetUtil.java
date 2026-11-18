package ru.asteria.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

/** Есть ли у телефона сеть с выходом «в интернет» (Wi-Fi/моб. данные). */
final class NetUtil {
    private NetUtil() { }

    /**
     * Намеренно НЕ требуем NET_CAPABILITY_VALIDATED: на части прошивок/в некоторых странах проверка
     * доступности блокируется, и рабочая сеть выглядела бы «без интернета». Если сети на самом деле
     * нет (Wi-Fi без выхода), загрузку страницы поймает onReceivedError в MainActivity.
     */
    static boolean isOnline(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Throwable t) {
            return true; // не смогли узнать — считаем, что сеть есть, и пробуем как обычно
        }
    }
}
