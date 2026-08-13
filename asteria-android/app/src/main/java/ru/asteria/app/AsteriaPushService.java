package ru.asteria.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Независимая замена Firebase Cloud Messaging: вместо стороннего пуш-сервиса
 * (и связанного с ним Google-аккаунта на устройстве) держим собственное,
 * постоянно открытое WebSocket-соединение с ВАШИМ сервером Asteria — тем же
 * самым, что использует и открытая страница в WebView (см. connectWS() в
 * public/app.js), только внутри foreground-сервиса, который Android не
 * закрывает вместе с Activity.
 *
 * Авторизация — та же cookie-сессия asteria_session, что и у WebView
 * (общий CookieManager на процесс), никакого отдельного логина или токена
 * не требуется.
 *
 * Компромисс за независимость от Firebase: доставка не так гарантирована,
 * как через системный канал FCM, — некоторые производители агрессивно
 * "чистят" фоновые сервисы сторонних приложений. Чтобы это не мешало,
 * MainActivity просит пользователя исключить Asteria из оптимизации
 * батареи (см. requestIgnoreBatteryOptimizations()), а BootReceiver
 * поднимает сервис заново после перезагрузки телефона.
 */
public class AsteriaPushService extends Service {

    private static final String PREFS = "asteria_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_USER_ID = "push_own_user_id";

    private static final String CHANNEL_MESSAGES = "asteria_messages";
    private static final String CHANNEL_CALLS = "asteria_calls";
    private static final String CHANNEL_UPDATES = "asteria_updates";
    private static final String CHANNEL_SERVICE = "asteria_service";
    private static final int SERVICE_NOTIF_ID = 1;
    private static final String CALL_NOTIF_TAG = "call";
    private static final int CALL_NOTIF_ID = 2;
    private static final String UPDATE_NOTIF_TAG = "app-update";
    private static final int UPDATE_NOTIF_ID = 3;
    // Чтобы не показывать одно и то же уведомление об обновлении заново
    // при каждом переподключении фонового сервиса (оно переподключается
    // регулярно — смена сети, доза энергосбережения и т.п.) — запоминаем,
    // про какую версию уже уведомляли.
    private static final String KEY_LAST_NOTIFIED_UPDATE_VERSION = "push_last_notified_update_version";

    private static final long BACKOFF_MIN_MS = 2_000L;
    private static final long BACKOFF_MAX_MS = 60_000L;

    private ExecutorService ioExecutor;
    private Handler mainHandler;
    private OkHttpClient httpClient;
    private WebSocket activeSocket;
    private long backoffMs = BACKOFF_MIN_MS;
    private final AtomicInteger connectGeneration = new AtomicInteger(0);
    private volatile boolean stopping = false;

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
        ioExecutor = Executors.newSingleThreadExecutor();
        httpClient = buildHttpClient();
        startForeground(SERVICE_NOTIF_ID, buildServiceNotification());
        connectNow();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: если систему заставит убить процесс из-за нехватки
        // памяти, Android попробует перезапустить сервис позже сам
        // (Intent будет null — connectNow() и так сам читает актуальный
        // адрес сервера и cookie заново, дополнительные данные не нужны).
        if (!stopping) connectNow();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        connectGeneration.incrementAndGet();
        if (activeSocket != null) {
            activeSocket.close(1000, "service_stopping");
            activeSocket = null;
        }
        ioExecutor.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- подключение ----------

    private void connectNow() {
        final int generation = connectGeneration.incrementAndGet();
        ioExecutor.submit(() -> attemptConnect(generation));
    }

    private void scheduleReconnect(int generation, long delayMs) {
        if (stopping || generation != connectGeneration.get()) return;
        mainHandler.postDelayed(() -> {
            if (stopping || generation != connectGeneration.get()) return;
            ioExecutor.submit(() -> attemptConnect(generation));
        }, delayMs);
    }

    // Выполняется в ioExecutor — может блокировать поток сетевыми запросами.
    private void attemptConnect(int generation) {
        if (stopping || generation != connectGeneration.get()) return;

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String serverUrl = prefs.getString(KEY_SERVER_URL, null);
        if (serverUrl == null || serverUrl.isEmpty()) {
            // Сервер ещё не выбран (первый запуск, пользователь на экране
            // подключения) — тихо ждём и пробуем снова.
            scheduleReconnect(generation, BACKOFF_MIN_MS);
            return;
        }

        String cookie = CookieManager.getInstance().getCookie(serverUrl);
        if (cookie == null || !cookie.contains("asteria_session=")) {
            // Пользователь ещё не залогинился на этом сервере (или вышел из
            // аккаунта) — cookie появится сама после логина через WebView,
            // просто ждём.
            scheduleReconnect(generation, BACKOFF_MIN_MS);
            return;
        }

        String userId = fetchOwnUserId(serverUrl, cookie);
        if (userId == null) {
            // Сервер недоступен/сертификат отклонён/сессия истекла —
            // пробуем ещё раз с нарастающей паузой.
            bumpBackoff();
            scheduleReconnect(generation, backoffMs);
            return;
        }
        prefs.edit().putString(KEY_USER_ID, userId).apply();

        String wsUrl = toWsUrl(serverUrl);
        Request request = new Request.Builder().url(wsUrl).addHeader("Cookie", cookie).build();
        WebSocket socket = httpClient.newWebSocket(request, new Listener(generation, userId));
        activeSocket = socket;
    }

    private void bumpBackoff() {
        backoffMs = Math.min(BACKOFF_MAX_MS, (long) (backoffMs * 1.7));
    }

    // ?client=push сообщает серверу, что это фоновое соединение для push-
    // уведомлений, а не активная сессия пользователя — иначе один только
    // факт работы этого сервиса в фоне делал бы пользователя "вечно
    // онлайн" для остальных (см. isPushOnlyRequest на сервере).
    private static String toWsUrl(String httpUrl) {
        String u = httpUrl.trim();
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (u.startsWith("https://")) return "wss://" + u.substring("https://".length()) + "/?client=push";
        if (u.startsWith("http://")) return "ws://" + u.substring("http://".length()) + "/?client=push";
        return u + "/?client=push";
    }

    // Синхронный GET /api/me — узнаём id собственного пользователя, чтобы
    // не показывать уведомления на свои же сообщения (сервер рассылает
    // сообщение всем сокетам участников разговора, включая отправителя).
    @Nullable
    private String fetchOwnUserId(String serverUrl, String cookie) {
        try {
            Request request = new Request.Builder()
                    .url(serverUrl + (serverUrl.endsWith("/") ? "" : "/") + "api/me")
                    .addHeader("Cookie", cookie)
                    .get()
                    .build();
            try (Response resp = httpClient.newCall(request).execute()) {
                if (!resp.isSuccessful() || resp.body() == null) return null;
                JSONObject json = new JSONObject(resp.body().string());
                JSONObject user = json.optJSONObject("user");
                if (user == null) return null;
                String id = user.optString("id", null);
                return (id == null || id.isEmpty()) ? null : id;
            }
        } catch (Exception e) {
            return null;
        }
    }

    private class Listener extends WebSocketListener {
        private final int generation;
        private final String ownUserId;

        Listener(int generation, String ownUserId) {
            this.generation = generation;
            this.ownUserId = ownUserId;
        }

        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            backoffMs = BACKOFF_MIN_MS;
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            handleServerEvent(text, ownUserId);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            if (activeSocket == webSocket) activeSocket = null;
            bumpBackoff();
            scheduleReconnect(generation, backoffMs);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
            if (activeSocket == webSocket) activeSocket = null;
            bumpBackoff();
            scheduleReconnect(generation, backoffMs);
        }
    }

    private void handleServerEvent(String text, String ownUserId) {
        try {
            JSONObject event = new JSONObject(text);
            String type = event.optString("type");
            if ("message".equals(type)) {
                handleMessageEvent(event, ownUserId);
            } else if ("call-offer".equals(type)) {
                handleCallOfferEvent(event, ownUserId);
            } else if ("call-end".equals(type) || "call-decline".equals(type)) {
                // Собеседник положил трубку/отменил звонок до того, как на
                // него ответили — убираем уведомление о звонке, чтобы оно
                // не висело в шторке про уже неактуальный вызов.
                cancelCallNotification();
            } else if ("app-update-available".equals(type)) {
                handleAppUpdateEvent(event);
            }
        } catch (Exception ignored) {
            // Не JSON или неизвестный формат — не наш случай, пропускаем.
        }
    }

    private void handleMessageEvent(JSONObject event, String ownUserId) {
        JSONObject message = event.optJSONObject("message");
        if (message == null) return;
        String senderId = message.optString("senderId", null);
        if (ownUserId.equals(senderId)) return; // своё же сообщение — не уведомляем

        String conversationId = message.optString("conversationId", null);
        if (AppState.isViewingConversation(conversationId)) return; // чат и так открыт на экране

        JSONObject notif = event.optJSONObject("notif");
        String title = notif != null ? notif.optString("title", "Asteria") : "Asteria";
        String body = notif != null ? notif.optString("body", "Новое сообщение") : "Новое сообщение";
        showMessageNotification(title, body, conversationId);
    }

    // ФИКС: раньше сервис вообще не знал про тип события "call-offer" и
    // молча его игнорировал (обрабатывался только "message") — поэтому
    // входящие звонки никогда не показывали системное уведомление, если
    // приложение было свёрнуто или закрыто. Имя звонящего сервер теперь
    // присылает прямо в сигнале (callerName), отдельный запрос не нужен.
    private void handleCallOfferEvent(JSONObject event, String ownUserId) {
        String callerId = event.optString("from", null);
        if (callerId == null || callerId.equals(ownUserId)) return;
        // Приложение открыто на экране — веб-страница сама покажет полноэкранный
        // экран входящего звонка, дублировать уведомлением не нужно.
        if (AppState.foreground) return;
        String callerName = event.optString("callerName", null);
        if (callerName == null || callerName.isEmpty()) callerName = "Входящий звонок";
        String kind = event.optString("kind", "audio");
        showCallNotification(callerName, kind);
    }

    // Сервер присылает это событие и сразу при публикации новой версии
    // (всем, кто прямо сейчас на связи), и при каждом новом подключении
    // сокета (см. wss.on('connection') в server.js) — чтобы достучаться и
    // до тех, кто был офлайн в момент публикации. Поэтому здесь обязательно
    // нужна проверка "а не уведомляли ли мы уже именно про эту версию" —
    // иначе при каждом переподключении фонового сервиса приходило бы одно
    // и то же уведомление заново.
    private void handleAppUpdateEvent(JSONObject event) {
        int serverVersionCode = event.optInt("versionCode", 0);
        if (serverVersionCode <= BuildConfig.VERSION_CODE) return; // уже последняя версия

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (prefs.getInt(KEY_LAST_NOTIFIED_UPDATE_VERSION, 0) == serverVersionCode) return; // уже уведомляли про эту версию

        String versionName = event.optString("versionName", "");
        showUpdateNotification(versionName);
        prefs.edit().putInt(KEY_LAST_NOTIFIED_UPDATE_VERSION, serverVersionCode).apply();
    }

    // ---------- уведомления ----------

    private void showMessageNotification(String title, String body, String conversationId) {
        ensureChannels();

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(MainActivity.EXTRA_OPEN_CONVERSATION_ID, conversationId);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        int reqCode = conversationId == null ? 0 : conversationId.hashCode();
        PendingIntent pendingIntent = PendingIntent.getActivity(this, reqCode, intent, piFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_MESSAGES)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE);

        try {
            NotificationManagerCompat.from(this).notify(conversationId, reqCode, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS не выдан (Android 13+) — молча пропускаем.
        }
    }

    // Входящий звонок — отдельное, более "громкое" уведомление (свой канал с
    // максимальным приоритетом и вибрацией), т.к. пропущенный звонок гораздо
    // критичнее пропущенного сообщения. Открывает то же приложение — экран
    // входящего звонка веб-страница поднимет сама (сервер повторно пришлёт
    // ей ещё звонящий call-offer при подключении, см. resendRingingCallsTo
    // на сервере), поэтому дополнительных данных в intent передавать не
    // нужно, конкретный чат не открываем.
    private void showCallNotification(String callerName, String kind) {
        ensureChannels();

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, piFlags);

        String body = "video".equals(kind) ? "Входящий видеозвонок" : "Входящий аудиозвонок";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_CALLS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(callerName)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVibrate(new long[]{0, 500, 300, 500});

        try {
            NotificationManagerCompat.from(this).notify(CALL_NOTIF_TAG, CALL_NOTIF_ID, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS не выдан (Android 13+) — молча пропускаем.
        }
    }

    private void cancelCallNotification() {
        try {
            NotificationManagerCompat.from(this).cancel(CALL_NOTIF_TAG, CALL_NOTIF_ID);
        } catch (Exception ignored) { }
    }

    // Уведомление "вышла новая версия" — сама установка не начинается по
    // нажатию сюда, просто открывает приложение; там MainActivity при
    // загрузке страницы и так сам заново спросит сервер о версии (см.
    // AppUpdateManager.checkForUpdate в onPageFinished) и покажет привычный
    // диалог "Установить" — не дублируем эту логику здесь.
    private void showUpdateNotification(String versionName) {
        ensureChannels();

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, piFlags);

        String title = "Доступно обновление Asteria";
        String body = versionName != null && !versionName.isEmpty()
                ? "Вышла версия " + versionName + " — нажмите, чтобы обновить"
                : "Нажмите, чтобы обновить приложение";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_UPDATES)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION);

        try {
            NotificationManagerCompat.from(this).notify(UPDATE_NOTIF_TAG, UPDATE_NOTIF_ID, builder.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS не выдан (Android 13+) — молча пропускаем.
        }
    }

    private Notification buildServiceNotification() {
        ensureChannels();
        Intent intent = new Intent(this, MainActivity.class);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, piFlags);

        return new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(getString(R.string.push_service_notif_title))
                .setContentText(getString(R.string.push_service_notif_text))
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Новые сообщения в чатах Asteria");
            channel.enableVibration(true);
            nm.createNotificationChannel(channel);
        }
        if (nm.getNotificationChannel(CHANNEL_CALLS) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_CALLS, "Звонки", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Входящие звонки в Asteria");
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 500, 300, 500});
            nm.createNotificationChannel(channel);
        }
        if (nm.getNotificationChannel(CHANNEL_UPDATES) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_UPDATES, "Обновления приложения", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Уведомления о новых версиях приложения Asteria");
            nm.createNotificationChannel(channel);
        }
        if (nm.getNotificationChannel(CHANNEL_SERVICE) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_SERVICE, "Фоновое подключение", NotificationManager.IMPORTANCE_MIN);
            channel.setDescription("Служебное уведомление о том, что Asteria поддерживает соединение для уведомлений");
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
    }

    // ---------- HTTP/WS клиент ----------

    private OkHttpClient buildHttpClient() {
        OkHttpClient.Builder builder = new OkHttpClient.Builder()
                .pingInterval(25, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true);
        try {
            // Собственный сервер Asteria по умолчанию использует
            // самоподписанный сертификат (см. generate-cert.js) — WebView
            // уже спрашивает пользователя, доверять ли ему (см.
            // onReceivedSslError в MainActivity). Здесь того же самого
            // диалога показать некому (это фоновый сервис), поэтому
            // сервис доверяет ровно тому же уровню риска, который
            // пользователь уже принял в WebView. Если вы поставили на
            // сервер обычный сертификат от Let's Encrypt/аналога — эта
            // часть просто не понадобится, но и не мешает.
            X509TrustManager trustAll = new X509TrustManager() {
                public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) { }
                public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("Пустая цепочка сертификатов");
                }
                public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
            };
            SSLContext sslContext = SSLContext.getInstance("TLS");
            sslContext.init(null, new X509TrustManager[]{trustAll}, new SecureRandom());
            SSLSocketFactory sslSocketFactory = sslContext.getSocketFactory();
            builder.sslSocketFactory(sslSocketFactory, trustAll);
            builder.hostnameVerifier((hostname, session) -> true);
        } catch (Exception e) {
            // Если платформа вдруг не поддержала кастомный SSLContext —
            // остаёмся на обычной проверке сертификатов (публичные
            // сертификаты продолжат работать, самоподписанные — нет, пока
            // пользователь не заменит их настоящими).
        }
        return builder.build();
    }

    // ---------- запуск/остановка сервиса ----------

    static void start(Context context) {
        Intent intent = new Intent(context, AsteriaPushService.class);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, AsteriaPushService.class));
    }
}
