package ru.asteria.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import android.text.TextUtils;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import android.os.PowerManager;
import android.provider.Settings;

/**
 * Простая обёртка над веб-версией Asteria: само приложение (сайт + база
 * данных) по-прежнему запускается как обычно, командой `node server.js`, на
 * вашем сервере — APK лишь открывает этот сервер в полноэкранном WebView и
 * даёт доступ к камере/микрофону/загрузке файлов, чтобы звонки, голосовые
 * сообщения и кружки работали так же, как в браузере.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "asteria_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_ASKED_BATTERY_OPT = "asked_battery_opt";
    private static final int REQ_PERMISSIONS = 1001;
    private static final int REQ_FILE_CHOOSER = 2001;
    // Ключ intent-extra, которым уведомление сообщает MainActivity, какой
    // именно чат нужно открыть после того, как пользователь тапнет по нему
    // (см. AsteriaPushService.showMessageNotification() и
    // tryOpenPendingConversation() ниже).
    public static final String EXTRA_OPEN_CONVERSATION_ID = "open_conversation_id";
    // Ключи intent-extra, которыми кнопка "Принять" в уведомлении о звонке
    // (см. AsteriaPushService.showCallNotification) сообщает MainActivity,
    // какой именно звонок нужно принять автоматически, как только он
    // придёт по WebSocket. Полностью без открытия приложения тут не
    // обойтись (в отличие от "Отклонить") — сам приём звонка требует
    // WebRTC-логики, которая живёт в JS на загруженной странице.
    public static final String EXTRA_AUTO_ACCEPT_CALL_ID = "auto_accept_call_id";
    public static final String EXTRA_AUTO_ACCEPT_CALLER_ID = "auto_accept_caller_id";
    // Адрес вашего сервера по умолчанию — при первом запуске приложение
    // подключается сюда само, без экрана ввода адреса. Сменить позже можно
    // через меню (⋮ → «Сменить сервер»).
    //
    // ВАЖНО: указан адрес через sslip.io (46-8-227-207.sslip.io), а не голый
    // IP (46.8.227.207) — потому что настоящий доверенный сертификат
    // Let's Encrypt сервер получает именно на это доменное имя (Let's Encrypt
    // физически не может выписать сертификат на голый IP-адрес — см.
    // tryAutoHttps() в server.js). При заходе по голому IP браузер/WebView
    // будет видеть несовпадение адреса и сертификата и всё равно показывать
    // предупреждение "не защищено", даже если сертификат сам по себе
    // настоящий. Если сервер переехал на другой IP или свой домен — поменяйте
    // и это значение соответственно.
    private static final String DEFAULT_SERVER_URL = "https://46-8-227-207.sslip.io:3443/";

    private View setupLayout;
    private EditText serverUrlInput;
    private TextView setupErrorText;
    private Button connectButton;

    private SwipeRefreshLayout swipeRefresh;
    private WebView webView;
    private ProgressBar progressBar;

    private ValueCallback<Uri[]> fileChooserCallback;
    private String pendingServerUrl;
    // Id чата, который нужно открыть, когда страница дозагрузится (пришли по
    // тапу на уведомление — либо холодный старт, либо приложение уже было
    // открыто и просто получило новый Intent).
    private String pendingOpenConversationId;
    // Счётчик автоматических повторных попыток загрузки страницы при
    // SSL_EXPIRED/SSL_NOTYETVALID — см. onReceivedSslError ниже. Сбрасывается
    // при каждой успешной загрузке страницы (onPageFinished), чтобы после
    // очередной перезагрузки телефона снова было доступно несколько попыток,
    // а не "истрачено один раз и на этом всё" на весь срок жизни процесса.
    private int sslClockRetryCount = 0;
    // Тот же принцип, что и pendingOpenConversationId выше, только для
    // автоматического приёма звонка по нажатию "Принять" в уведомлении —
    // см. tryAutoAcceptCall() ниже.
    private String pendingAutoAcceptCallId;
    private String pendingAutoAcceptCallerId;

    // ---- «Поделиться» из других приложений (ACTION_SEND / SEND_MULTIPLE) ----
    // Путь, по которому страница забирает присланные файлы. Запрос
    // перехватывается в shouldInterceptRequest() и отдаётся прямо из
    // content:// URI — без копирования файла и без base64 через JS-мост.
    private static final String SHARE_PATH_PREFIX = "/__asteria_share__/";
    private static class SharedFile { Uri uri; String name; String mime; long size; }
    private final List<SharedFile> sharedFiles = new ArrayList<>();
    private int shareGeneration = 0;
    // Готовый JSON ({text, files:[{url,name,mime,size}]}) — ждёт, пока
    // страница загрузится (холодный старт) и будет передан в JS.
    private String pendingShareJson;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        setupLayout = findViewById(R.id.setupLayout);
        serverUrlInput = findViewById(R.id.serverUrlInput);
        setupErrorText = findViewById(R.id.setupErrorText);
        connectButton = findViewById(R.id.connectButton);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        requestRuntimePermissions();

        pendingOpenConversationId = getIntent() != null ? getIntent().getStringExtra(EXTRA_OPEN_CONVERSATION_ID) : null;
        pendingAutoAcceptCallId = getIntent() != null ? getIntent().getStringExtra(EXTRA_AUTO_ACCEPT_CALL_ID) : null;
        pendingAutoAcceptCallerId = getIntent() != null ? getIntent().getStringExtra(EXTRA_AUTO_ACCEPT_CALLER_ID) : null;

        if (savedInstanceState == null) handleShareIntent(getIntent());

        connectButton.setOnClickListener(v -> onConnectClicked());
        swipeRefresh.setOnRefreshListener(() -> webView.reload());
        // Свайп вниз для обновления страницы конфликтовал со скроллом чата —
        // телефон путал "долистать вверх до начала переписки" с "потянуть для
        // обновления". Функция отключена полностью; обновление доступно только
        // программно (например при ошибке загрузки).
        swipeRefresh.setEnabled(false);

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String savedUrl = prefs.getString(KEY_SERVER_URL, null);
        serverUrlInput.setText(DEFAULT_SERVER_URL);
        if (savedUrl != null) {
            showWebView(savedUrl);
        } else {
            // Первый запуск — сразу подключаемся к серверу по умолчанию, не
            // заставляя человека вводить адрес вручную.
            prefs.edit().putString(KEY_SERVER_URL, DEFAULT_SERVER_URL).apply();
            showWebView(DEFAULT_SERVER_URL);
        }

        // Собственный (без Firebase) push-сервис — держит постоянное
        // WebSocket-соединение с сервером и сам покажет системное
        // уведомление, если приложение свёрнуто или закрыто. Он сам ждёт
        // появления cookie сессии после логина, так что запускать его можно
        // сразу, даже до того как человек вошёл в аккаунт.
        AsteriaPushService.start(this);
        requestIgnoreBatteryOptimizations();
    }

    @Override
    protected void onResume() {
        super.onResume();
        AppState.foreground = true;
    }

    // Просит пользователя исключить приложение из оптимизации батареи —
    // без этого некоторые производители Android агрессивно "замораживают"
    // фоновые сервисы сторонних приложений, и постоянное WS-соединение
    // AsteriaPushService может обрываться надолго. Стандартная практика для
    // мессенджеров без Firebase (Signal, Element и т.п.). Спрашиваем только
    // один раз — если человек откажется, повторно не докучаем.
    private void requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(KEY_ASKED_BATTERY_OPT, false)) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        prefs.edit().putBoolean(KEY_ASKED_BATTERY_OPT, true).apply();
        new AlertDialog.Builder(this)
                .setTitle(R.string.battery_optimization_title)
                .setMessage(R.string.battery_optimization_message)
                .setPositiveButton(R.string.battery_optimization_allow, (d, w) -> {
                    try {
                        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    } catch (Exception ignored) { }
                })
                .setNegativeButton(R.string.battery_optimization_later, null)
                .show();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleShareIntent(intent)) deliverPendingShare();
        String convId = intent != null ? intent.getStringExtra(EXTRA_OPEN_CONVERSATION_ID) : null;
        if (convId != null) {
            pendingOpenConversationId = convId;
            tryOpenPendingConversation();
        }
        String autoAcceptCallId = intent != null ? intent.getStringExtra(EXTRA_AUTO_ACCEPT_CALL_ID) : null;
        if (autoAcceptCallId != null) {
            pendingAutoAcceptCallId = autoAcceptCallId;
            pendingAutoAcceptCallerId = intent.getStringExtra(EXTRA_AUTO_ACCEPT_CALLER_ID);
            tryAutoAcceptCall();
        }
    }

    // ---------------------------------------------------------------
    // «Поделиться» -> Asteria
    // ---------------------------------------------------------------

    /**
     * Разбирает входящий ACTION_SEND / ACTION_SEND_MULTIPLE и готовит JSON
     * для страницы. @return true, если в интенте действительно было что
     * отправить.
     */
    @SuppressWarnings("deprecation")
    private boolean handleShareIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        // Повторный запуск из списка недавних не должен слать то же самое ещё раз.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false;

        List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) for (Uri u : list) if (u != null) uris.add(u);
            }
        } catch (Exception ignored) { }
        // Некоторые приложения кладут файл только в ClipData
        if (uris.isEmpty() && intent.getClipData() != null) {
            for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                Uri u = intent.getClipData().getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }

        CharSequence textCs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = textCs != null ? textCs.toString() : "";
        if (text.isEmpty() && uris.isEmpty()) return false;
        // Тема письма/заметки — добавляем к тексту, если она там не повторяется
        CharSequence subj = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        if (subj != null && subj.length() > 0 && !text.contains(subj) && uris.isEmpty()) {
            text = subj + "\n" + text;
        }

        sharedFiles.clear();
        shareGeneration++;
        String fallbackMime = intent.getType();
        for (Uri uri : uris) {
            SharedFile f = new SharedFile();
            f.uri = uri;
            f.name = null;
            f.size = -1;
            try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (ni >= 0) f.name = c.getString(ni);
                    if (si >= 0 && !c.isNull(si)) f.size = c.getLong(si);
                }
            } catch (Exception ignored) { }
            if (f.name == null || f.name.isEmpty()) {
                String seg = uri.getLastPathSegment();
                f.name = seg != null ? seg : "file";
            }
            String mime = null;
            try { mime = getContentResolver().getType(uri); } catch (Exception ignored) { }
            if (mime == null || mime.isEmpty()) mime = (fallbackMime != null && !fallbackMime.contains("*")) ? fallbackMime : "application/octet-stream";
            f.mime = mime;
            sharedFiles.add(f);
        }

        try {
            JSONObject json = new JSONObject();
            json.put("text", text);
            JSONArray arr = new JSONArray();
            for (int i = 0; i < sharedFiles.size(); i++) {
                SharedFile f = sharedFiles.get(i);
                JSONObject o = new JSONObject();
                o.put("url", SHARE_PATH_PREFIX + shareGeneration + "/" + i);
                o.put("name", f.name);
                o.put("mime", f.mime);
                o.put("size", f.size);
                arr.put(o);
            }
            json.put("files", arr);
            pendingShareJson = json.toString();
        } catch (Exception e) {
            pendingShareJson = null;
            return false;
        }
        // Интент обработан — чтобы он не сработал повторно
        intent.setAction(Intent.ACTION_MAIN);
        return true;
    }

    private void deliverPendingShare() {
        if (pendingShareJson == null || webView == null) return;
        String json = pendingShareJson;
        pendingShareJson = null;
        String js = "window.handleSharedContentFromAndroid && window.handleSharedContentFromAndroid("
                + JSONObject.quote(json) + ");";
        webView.evaluateJavascript(js, null);
    }

    // Отдаёт странице присланный файл по адресу /__asteria_share__/<поколение>/<номер>
    private WebResourceResponse serveSharedFile(WebResourceRequest request) {
        try {
            String path = request.getUrl().getPath();
            if (path == null || !path.startsWith(SHARE_PATH_PREFIX)) return null;
            String[] parts = path.substring(SHARE_PATH_PREFIX.length()).split("/");
            if (parts.length != 2) return null;
            int gen = Integer.parseInt(parts[0]);
            int idx = Integer.parseInt(parts[1]);
            if (gen != shareGeneration || idx < 0 || idx >= sharedFiles.size()) return null;
            SharedFile f = sharedFiles.get(idx);
            InputStream in = getContentResolver().openInputStream(f.uri);
            if (in == null) return null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Access-Control-Allow-Origin", "*");
            if (f.size >= 0) headers.put("Content-Length", String.valueOf(f.size));
            return new WebResourceResponse(f.mime, null, 200, "OK", headers, in);
        } catch (Exception e) {
            return null;
        }
    }

    // Как только страница дозагрузилась, дёргаем JS-функцию из public/app.js,
    // которая переключает секцию на "Чаты" и открывает нужный разговор. Сама
    // функция умеет подождать, если состояние приложения (state.user,
    // список чатов) ещё не успело подгрузиться.
    private void tryOpenPendingConversation() {
        if (pendingOpenConversationId == null || webView == null) return;
        String convId = pendingOpenConversationId;
        pendingOpenConversationId = null;
        String js = "window.openConversationFromAndroid && window.openConversationFromAndroid("
                + org.json.JSONObject.quote(convId) + ");";
        webView.evaluateJavascript(js, null);
    }

    // Аналогично tryOpenPendingConversation(), но для автоматического
    // приёма звонка по нажатию "Принять" в системном уведомлении (см.
    // AsteriaPushService.showCallNotification). Сам звонок (SDP-оффер)
    // страница получит по WebSocket отдельно — здесь только просим JS
    // принять его сразу, как только он появится, вместо того чтобы
    // показывать обычный экран "Входящий звонок" с кнопками.
    private void tryAutoAcceptCall() {
        if (pendingAutoAcceptCallId == null || webView == null) return;
        String callId = pendingAutoAcceptCallId;
        String callerId = pendingAutoAcceptCallerId;
        pendingAutoAcceptCallId = null;
        pendingAutoAcceptCallerId = null;
        String js = "window.autoAcceptCallFromAndroid && window.autoAcceptCallFromAndroid("
                + org.json.JSONObject.quote(callId) + ", " + org.json.JSONObject.quote(callerId) + ");";
        webView.evaluateJavascript(js, null);
    }

    private void requestRuntimePermissions() {
        java.util.ArrayList<String> needed = new java.util.ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        // Для кнопки "📍 Геолокация" в чате — запрашиваем сразу точную и
        // приблизительную (система сама решит, что выдать; хватает любой).
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        // Скачивание фото/видео в галерею и файлов из чата (см.
        // FileDownloader) на API 24-28 (до scoped storage) требует это
        // разрешение в рантайме — без него запись в публичную директорию
        // падает с SecurityException, и файл тихо не сохраняется. На
        // API 29+ разрешение не нужно (и запрашивать его там уже нельзя —
        // оно deprecated), поэтому проверяем только для старых версий.
        if (Build.VERSION.SDK_INT < 29 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), REQ_PERMISSIONS);
        }
    }

    private void showSetupScreen() {
        setupLayout.setVisibility(View.VISIBLE);
        swipeRefresh.setVisibility(View.GONE);
    }

    private void onConnectClicked() {
        String url = serverUrlInput.getText().toString().trim();
        if (TextUtils.isEmpty(url) || !(url.startsWith("http://") || url.startsWith("https://"))) {
            setupErrorText.setVisibility(View.VISIBLE);
            setupErrorText.setText(R.string.setup_error);
            return;
        }
        setupErrorText.setVisibility(View.GONE);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER_URL, url).apply();
        showWebView(url);
        AsteriaPushService.start(this);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showWebView(String url) {
        setupLayout.setVisibility(View.GONE);
        swipeRefresh.setVisibility(View.VISIBLE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(true);
        // Без этого navigator.geolocation в самой веб-странице всегда будет
        // недоступен внутри WebView, даже если системное разрешение на
        // геолокацию у приложения уже есть — WebView запрашивает его
        // отдельно через onGeolocationPermissionsShowPrompt() ниже.
        s.setGeolocationEnabled(true);

        // Сессия Asteria (30-дневная кука asteria_session) хранится браузерным
        // cookie-хранилищем WebView. По умолчанию оно и так принимает куки, но
        // мы включаем это явно — и, что важнее, ниже (onPause/onStop) сами
        // сбрасываем cookie-хранилище на диск через flush(). Без этого куки
        // какое-то время живут только в памяти процесса: если Android убивает
        // фоновое приложение (что происходит регулярно, особенно на слабых
        // телефонах или после "смахивания" из списка недавних) до того, как
        // система сама решит сохранить их на диск — сессия теряется, и
        // человека при следующем запуске выкидывает на экран входа, хотя он
        // никогда явно не выходил из аккаунта.
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Мост для системных уведомлений о новых сообщениях — см.
        // WebAppInterface и notifyNewMessage() в public/app.js.
        webView.addJavascriptInterface(new WebAppInterface(this), "AsteriaNotify");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse shared = serveSharedFile(request);
                if (shared != null) return shared;
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String host = request.getUrl().getHost();
                String ourHost = Uri.parse(pendingServerUrl != null ? pendingServerUrl : url).getHost();
                if (host != null && host.equals(ourHost)) {
                    return false; // остаёмся внутри приложения
                }
                // внешняя ссылка (например, из сообщения) — открываем в обычном браузере
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pendingServerUrl = url;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefresh.setRefreshing(false);
                sslClockRetryCount = 0; // страница загрузилась нормально — часы точно синхронизировались
                tryOpenPendingConversation();
                tryAutoAcceptCall();
                deliverPendingShare();
                AppUpdateManager.checkForUpdate(MainActivity.this, pendingServerUrl != null ? pendingServerUrl : url);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // ФИКС "уведомление о самоподписанном сертификате один раз
                // после каждой перезагрузки телефона у всех пользователей":
                // сервер использует настоящий сертификат Let's Encrypt (не
                // самоподписанный) — но сразу после перезагрузки системные
                // часы Android какое-то время "врут" (NTP ещё не успел
                // синхронизироваться), из-за чего абсолютно нормальный
                // сертификат на секунду-другую выглядит для TLS-стека "ещё
                // не начал действовать"/"уже истёк". Тип ошибки при этом —
                // SSL_NOTYETVALID/SSL_EXPIRED, а не "неизвестный удостоверяющий
                // центр" (SSL_UNTRUSTED, вот это уже был бы настоящий
                // самоподписанный сертификат). Раньше диалог не различал эти
                // случаи и всегда писал "самоподписанный", вводя людей в
                // заблуждение. Теперь для похожих на рассинхронизацию часов
                // ошибок молча ждём пару секунд и перезагружаем страницу — к
                // тому моменту часы почти наверняка уже синхронизировались.
                int primaryError = error.getPrimaryError();
                boolean looksLikeClockSkew = primaryError == SslError.SSL_EXPIRED || primaryError == SslError.SSL_NOTYETVALID;
                if (looksLikeClockSkew && sslClockRetryCount < 3) {
                    sslClockRetryCount++;
                    handler.cancel();
                    new android.os.Handler(getMainLooper()).postDelayed(() -> {
                        if (webView != null) webView.reload();
                    }, 2500);
                    return;
                }
                // Настоящий недоверенный/самоподписанный сертификат (или
                // рассинхрон часов не прошёл за 3 попытки) — вот тут диалог
                // действительно уместен.
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.ssl_warning_title)
                        .setMessage(R.string.ssl_warning_message)
                        .setPositiveButton(R.string.ssl_warning_proceed, (d, w) -> handler.proceed())
                        .setNegativeButton(R.string.ssl_warning_cancel, (d, w) -> handler.cancel())
                        .setCancelable(false)
                        .show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                progressBar.setProgress(newProgress);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Пробрасываем запрос камеры/микрофона из WebView (нужно для
                // звонков, голосовых сообщений и кружков) — но только если
                // соответствующее системное разрешение Android уже выдано.
                runOnUiThread(() -> {
                    java.util.ArrayList<String> granted = new java.util.ArrayList<>();
                    for (String res : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                                && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            granted.add(res);
                        } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                                && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            granted.add(res);
                        }
                    }
                    if (!granted.isEmpty()) {
                        request.grant(granted.toArray(new String[0]));
                    } else {
                        request.deny();
                        requestRuntimePermissions();
                    }
                });
            }

            // Разрешение на геолокацию для navigator.geolocation внутри
            // страницы (кнопка "📍 Геолокация" в чате) — отдельный колбэк,
            // не связанный с onPermissionRequest() выше.
            //
            // ФИКС: метод назывался onGeolocationPermissionsShow — такого
            // метода в WebChromeClient не существует (опечатка, пропущено
            // "Prompt" на конце), поэтому @Override не компилировался ("method
            // does not override or implement a method from a supertype").
            // Правильное имя — onGeolocationPermissionsShowPrompt, см.
            // https://developer.android.com/reference/android/webkit/WebChromeClient
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                runOnUiThread(() -> {
                    boolean hasLocation =
                            ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                                    || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                    if (hasLocation) {
                        callback.invoke(origin, true, false);
                    } else {
                        callback.invoke(origin, false, false);
                        requestRuntimePermissions();
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // Загрузка фото/видео/файлов через <input type="file"> (аватар,
                // фото в чат, кастомные обои и т.д.)
                fileChooserCallback = callback;
                Intent intent = params.createIntent();
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    fileChooserCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((dUrl, userAgent, contentDisposition, mimetype, contentLength) -> {
            // blob: скачивания (фото/видео из лайтбокса) идут в обход этого
            // листенера — через WebAppInterface.downloadMedia(), вызываемый
            // прямо из JS с настоящей ссылкой на сервер. Сюда, через
            // системный DownloadListener, blob: попасть не должен, но на
            // всякий случай — открыть его всё равно было бы нечем (blob:
            // живёт только внутри процесса WebView).
            if (dUrl == null || dUrl.startsWith("blob:")) return;
            // ФИКС ("Загрузка начата" и файл так и не появляется): здесь
            // тоже раньше был системный DownloadManager — а он не в курсе,
            // что пользователь уже согласился доверять self-signed/ещё не
            // провалидированному сертификату этого сервера внутри WebView
            // (см. onReceivedSslError выше). DownloadManager ставил запрос
            // в очередь без ошибок (отсюда бодрый тост "Загрузка начата"),
            // а сама загрузка потом молча проваливалась на TLS-рукопожатии.
            // Качаем файл теми же силами и с тем же доверием к сертификату,
            // что и сама открытая страница — см. FileDownloader.
            String fname = URLUtil.guessFileName(dUrl, contentDisposition, mimetype);
            Toast.makeText(this, "Загрузка начата", Toast.LENGTH_SHORT).show();
            FileDownloader.download(getApplicationContext(), this, dUrl, fname, mimetype, "file");
        });

        pendingServerUrl = url;
        webView.loadUrl(url);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        super.onPause();
        AppState.foreground = false;
        flushCookies();
    }

    @Override
    protected void onStop() {
        super.onStop();
        flushCookies();
    }

    // См. комментарий у CookieManager в showWebView() — принудительно пишем
    // cookie-хранилище на диск, чтобы 30-дневная сессия не терялась, если
    // Android убьёт процесс приложения, пока оно свёрнуто.
    private void flushCookies() {
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) { }
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileChooserCallback == null) { super.onActivityResult(requestCode, resultCode, data); return; }
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (swipeRefresh.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_reload) {
            webView.reload();
            return true;
        } else if (id == R.id.action_change_server) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_SERVER_URL).apply();
            AsteriaPushService.stop(this);
            webView.loadUrl("about:blank");
            serverUrlInput.setText(DEFAULT_SERVER_URL);
            showSetupScreen();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
