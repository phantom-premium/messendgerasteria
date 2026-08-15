package ru.asteria.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
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
    private static final String DEFAULT_SERVER_URL = "https://46-8-227-207.sslip.io:3443";

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
        String convId = intent != null ? intent.getStringExtra(EXTRA_OPEN_CONVERSATION_ID) : null;
        if (convId != null) {
            pendingOpenConversationId = convId;
            tryOpenPendingConversation();
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
        // Скачивание фото/видео в галерею (см. WebAppInterface.downloadMedia)
        // на API 24-28 (до scoped storage) требует это разрешение в рантайме
        // — без него DownloadManager.enqueue() с публичной директорией
        // назначения падает с SecurityException, и файл тихо не сохраняется.
        // На API 29+ разрешение не нужно (и запрашивать его там уже нельзя —
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
                tryOpenPendingConversation();
                AppUpdateManager.checkForUpdate(MainActivity.this, pendingServerUrl != null ? pendingServerUrl : url);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Собственный сервер Asteria по умолчанию использует
                // самоподписанный сертификат (см. generate-cert.js) — так же,
                // как в обычном браузере, спрашиваем подтверждение вместо
                // того чтобы либо молча всё принимать, либо блокировать вход.
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
            // blob: скачивания (фото/видео из лайтбокса) теперь идут в
            // обход этого листенера — через WebAppInterface.downloadMedia(),
            // вызываемый прямо из JS с настоящей ссылкой на сервер (см.
            // downloadCurrentLightboxMedia() в public/app.js). Сюда, через
            // системный DownloadListener, blob: попасть не должен, но на
            // всякий случай — Intent.ACTION_VIEW всё равно не смог бы его
            // открыть (blob: живёт только внутри процесса WebView).
            if (dUrl == null || dUrl.startsWith("blob:")) return;
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(dUrl));
                String fname = URLUtil.guessFileName(dUrl, contentDisposition, mimetype);
                request.setTitle(fname);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fname);
                request.allowScanningByMediaScanner();
                if (mimetype != null && !mimetype.isEmpty()) request.setMimeType(mimetype);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(request);
                Toast.makeText(this, "Загрузка начата", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(dUrl)));
                } catch (Exception e2) {
                    Toast.makeText(this, dUrl, Toast.LENGTH_SHORT).show();
                }
            }
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
