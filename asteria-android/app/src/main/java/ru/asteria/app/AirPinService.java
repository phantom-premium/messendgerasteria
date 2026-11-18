package ru.asteria.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * AirPin — связь без интернета и сотовой сети через цепочку чужих устройств.
 *
 * Что делает этот сервис:
 *  1. MESH-ТРАНСПОРТ. Через Google Nearby Connections (стратегия P2P_CLUSTER:
 *     Bluetooth/BLE + Wi-Fi Direct, интернет не нужен) находит соседей с
 *     Asteria и держит с ними соединения «каждый с каждым».
 *  2. РЕТРАНСЛЯЦИЯ (flooding). Любой новый зашифрованный конверт сохраняется
 *     в AirPinStore и пересылается всем соседям, у которых его ещё нет
 *     (счётчик ttl защищает от бесконечных кругов). Нет соседей — конверт
 *     лежит в хранилище и уйдёт, когда кто-то появится (отложенная отправка).
 *     При каждом новом соединении соседи обмениваются списками id и
 *     докачивают недостающее.
 *  3. МОСТ. Если у телефона есть интернет, он заливает накопленные
 *     конверты на сервер (POST /api/airpin/ingest) и забирает оттуда
 *     сообщения для соседей без интернета, раздавая их по mesh. Работает и
 *     когда приложение свёрнуто (сессия берётся из cookie WebView, как в
 *     AsteriaPushService).
 *
 * Содержимое конвертов сервис не читает и прочитать не может — шифрованием
 * и расшифровкой занимается страница (public/airpin.js).
 */
public class AirPinService extends Service {

    static final String SERVICE_ID = "ru.asteria.airpin.v1";
    static final String NAME_PREFIX = "AP1|";
    static final String ACTION_STOP = "ru.asteria.app.AIRPIN_STOP";
    static final String EXTRA_USER_ID = "userId";
    static final String EXTRA_SINCE = "since";

    static final String PREFS = "asteria_prefs";
    static final String KEY_ENABLED = "airpin_enabled";
    static final String KEY_USER_ID = "airpin_user_id";
    static final String KEY_SINCE = "airpin_since";
    private static final String KEY_SERVER_URL = "server_url";

    private static final String CHANNEL_ID = "airpin";
    private static final int NOTIF_ID = 7001;
    private static final int MAX_PEERS = 6;
    private static final int MAX_PACKET_BYTES = 30 * 1024;
    private static final int MAX_PACKETS_PER_MIN = 150;
    private static final long BRIDGE_POLL_MS = 15_000;
    private static final MediaType JSON_TYPE = MediaType.parse("application/json; charset=utf-8");

    /** Приёмник событий для страницы (ставится WebAppInterface). */
    interface Sink { void onEvent(String type, String json); }
    static volatile Sink sink = null;
    static volatile AirPinService instance = null;

    static final class Peer {
        final String endpointId;
        final String nodeId;
        volatile boolean connected = false;
        volatile String userId = "";
        volatile boolean net = false;
        volatile long since = 0;
        final Set<String> sent = ConcurrentHashMap.newKeySet();
        long rateWindowStart = 0;
        int rateCount = 0;
        Peer(String endpointId, String nodeId) { this.endpointId = endpointId; this.nodeId = nodeId; }
    }

    private ConnectionsClient client;
    private AirPinStore store;
    private Handler main;
    private ExecutorService io;
    private OkHttpClient http;
    private String nodeId;
    private String localName;
    private volatile String myUserId = "";
    private volatile long mySince = 0;
    private volatile boolean running = false;
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final Set<String> requested = new HashSet<>();
    private final Map<String, Long> peerSince = new ConcurrentHashMap<>();
    private final AtomicBoolean bridging = new AtomicBoolean(false);
    private volatile boolean advertising = false;
    private volatile boolean discovering = false;
    private ConnectivityManager.NetworkCallback netCallback;

    // ---------- API для остального приложения ----------

    static String[] requiredPermissions() {
        List<String> p = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            p.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            p.add(Manifest.permission.BLUETOOTH_CONNECT);
            p.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        if (Build.VERSION.SDK_INT >= 33) p.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        if (Build.VERSION.SDK_INT <= 32) p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        return p.toArray(new String[0]);
    }

    static boolean hasPermissions(Context c) {
        for (String perm : requiredPermissions()) {
            if (ContextCompat.checkSelfPermission(c, perm) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    static void start(Context ctx, String userId, long since) {
        Intent i = new Intent(ctx, AirPinService.class);
        i.putExtra(EXTRA_USER_ID, userId);
        i.putExtra(EXTRA_SINCE, since);
        ContextCompat.startForegroundService(ctx, i);
    }

    static void stop(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, false).apply();
        ctx.stopService(new Intent(ctx, AirPinService.class));
    }

    /** Конверт, созданный на этом устройстве (страница отправила офлайн). */
    void injectLocal(String envelopeJson) {
        main.post(() -> {
            try {
                JSONObject env = new JSONObject(envelopeJson);
                String id = env.getString("id");
                if (store.put(id, env.toString(), true)) {
                    floodEnvelope(id, null);
                    scheduleBridge(0);
                    emitStatus();
                }
            } catch (Exception ignored) { }
        });
    }

    void markConsumed(String id) { store.markDelivered(id); }

    void setSince(long since) {
        mySince = Math.max(mySince, since);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong(KEY_SINCE, mySince).apply();
    }

    /** Страница подключилась (или перезагрузилась): отдаём всё, что она ещё не видела. */
    void replayToPage() {
        io.execute(() -> {
            for (AirPinStore.Entry e : store.undeliveredToPage()) emit("env", e.envelope);
            emitStatus();
        });
    }

    String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("running", running);
            o.put("nodeId", nodeId);
            o.put("internet", hasInternet());
            o.put("pending", store.pendingCount());
            JSONArray arr = new JSONArray();
            for (Peer p : peers.values()) {
                if (!p.connected) continue;
                JSONObject po = new JSONObject();
                po.put("id", p.nodeId); po.put("user", p.userId); po.put("net", p.net);
                arr.put(po);
            }
            o.put("peers", arr);
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    // ---------- жизненный цикл ----------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        main = new Handler(Looper.getMainLooper());
        io = Executors.newSingleThreadExecutor();
        store = new AirPinStore(this);
        http = AsteriaPushService.buildHttpClient();
        byte[] rnd = new byte[4];
        new SecureRandom().nextBytes(rnd);
        StringBuilder sb = new StringBuilder();
        for (byte b : rnd) sb.append(String.format("%02x", b));
        nodeId = sb.toString();
        localName = NAME_PREFIX + nodeId;
        client = Nearby.getConnectionsClient(this);
        ensureChannel();
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent != null && intent.hasExtra(EXTRA_USER_ID)) {
            myUserId = intent.getStringExtra(EXTRA_USER_ID);
            mySince = Math.max(mySince, intent.getLongExtra(EXTRA_SINCE, 0));
            prefs.edit().putBoolean(KEY_ENABLED, true).putString(KEY_USER_ID, myUserId).putLong(KEY_SINCE, mySince).apply();
        } else {
            // перезапуск системой (START_STICKY) — восстанавливаем из настроек
            myUserId = prefs.getString(KEY_USER_ID, "");
            mySince = prefs.getLong(KEY_SINCE, 0);
            if (!prefs.getBoolean(KEY_ENABLED, false)) { stopSelf(); return START_NOT_STICKY; }
        }
        if (!hasPermissions(this)) { stopSelf(); return START_NOT_STICKY; }
        if (!running) {
            running = true;
            startMesh();
            registerNetworkCallback();
            tick();
        }
        emitStatus();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        try { main.removeCallbacksAndMessages(null); } catch (Exception ignored) { }
        try {
            if (netCallback != null) ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCallback);
        } catch (Exception ignored) { }
        try {
            client.stopAdvertising(); client.stopDiscovery(); client.stopAllEndpoints();
        } catch (Exception ignored) { }
        if (store != null) store.save(true);
        if (io != null) io.shutdownNow();
        emitStatus();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }

    // ---------- Nearby: реклама и поиск ----------

    private void startMesh() {
        startAdvertising();
        startDiscovery();
    }

    private void startAdvertising() {
        if (advertising) return;
        AdvertisingOptions opts = new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build();
        client.startAdvertising(localName, SERVICE_ID, lifecycle, opts)
                .addOnSuccessListener(v -> advertising = true)
                .addOnFailureListener(e -> {
                    String m = String.valueOf(e.getMessage());
                    if (m.contains("8001")) advertising = true; // STATUS_ALREADY_ADVERTISING
                    else if (running) main.postDelayed(this::startAdvertising, 10_000);
                });
    }

    private void startDiscovery() {
        if (discovering) return;
        DiscoveryOptions opts = new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build();
        client.startDiscovery(SERVICE_ID, discoveryCb, opts)
                .addOnSuccessListener(v -> discovering = true)
                .addOnFailureListener(e -> {
                    String m = String.valueOf(e.getMessage());
                    if (m.contains("8002")) discovering = true; // STATUS_ALREADY_DISCOVERING
                    else if (running) main.postDelayed(this::startDiscovery, 10_000);
                });
    }

    private int connectedCount() {
        int n = 0;
        for (Peer p : peers.values()) if (p.connected) n++;
        return n;
    }

    private final EndpointDiscoveryCallback discoveryCb = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            String name = info.getEndpointName();
            if (name == null || !name.startsWith(NAME_PREFIX)) return;
            String remoteNode = name.substring(NAME_PREFIX.length());
            if (remoteNode.equals(nodeId)) return;
            Peer existing = peers.get(endpointId);
            if (existing != null && existing.connected) return;
            if (connectedCount() >= MAX_PEERS) return;
            // Чтобы оба не стучались друг к другу одновременно: первым соединяется тот, у кого nodeId меньше.
            // Если за 6 секунд он не пришёл — стучимся сами (коллизию Nearby разрешает сам).
            long delay = nodeId.compareTo(remoteNode) < 0 ? 0 : 6000;
            main.postDelayed(() -> requestTo(endpointId, remoteNode), delay);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            requested.remove(endpointId);
        }
    };

    private void requestTo(String endpointId, String remoteNode) {
        if (!running) return;
        Peer p = peers.get(endpointId);
        if (p != null && p.connected) return;
        if (requested.contains(endpointId) || connectedCount() >= MAX_PEERS) return;
        requested.add(endpointId);
        client.requestConnection(localName, endpointId, lifecycle)
                .addOnFailureListener(e -> {
                    requested.remove(endpointId);
                });
    }

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            String name = info.getEndpointName();
            if (name == null || !name.startsWith(NAME_PREFIX) || connectedCount() >= MAX_PEERS) {
                client.rejectConnection(endpointId);
                return;
            }
            peers.put(endpointId, new Peer(endpointId, name.substring(NAME_PREFIX.length())));
            client.acceptConnection(endpointId, payloadCb);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            requested.remove(endpointId);
            Peer p = peers.get(endpointId);
            if (!result.getStatus().isSuccess() || p == null) { peers.remove(endpointId); emitStatus(); return; }
            p.connected = true;
            sendHello(p);
            emitStatus();
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            peers.remove(endpointId);
            requested.remove(endpointId);
            emitStatus();
            scheduleBridge(0);
        }
    };

    // ---------- обмен пакетами ----------

    private void sendHello(Peer p) {
        try {
            JSONObject h = new JSONObject();
            h.put("k", "h"); h.put("u", myUserId); h.put("net", hasInternet()); h.put("since", mySince);
            send(p, h);
            JSONObject inv = new JSONObject();
            inv.put("k", "i");
            inv.put("ids", new JSONArray(store.inventoryIds(150)));
            send(p, inv);
        } catch (Exception ignored) { }
    }

    private boolean send(Peer p, JSONObject pkt) {
        try {
            byte[] b = pkt.toString().getBytes(StandardCharsets.UTF_8);
            if (b.length > MAX_PACKET_BYTES) return false;
            client.sendPayload(p.endpointId, Payload.fromBytes(b));
            return true;
        } catch (Exception e) { return false; }
    }

    private final PayloadCallback payloadCb = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            Peer p = peers.get(endpointId);
            byte[] b = payload.asBytes();
            if (p == null || b == null || b.length > MAX_PACKET_BYTES + 1024) return;
            long now = System.currentTimeMillis();
            if (now - p.rateWindowStart > 60_000) { p.rateWindowStart = now; p.rateCount = 0; }
            if (++p.rateCount > MAX_PACKETS_PER_MIN) return; // защита от спама
            try {
                handlePacket(p, new JSONObject(new String(b, StandardCharsets.UTF_8)));
            } catch (Exception ignored) { }
        }

        @Override public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) { }
    };

    private void handlePacket(Peer p, JSONObject pkt) throws Exception {
        String k = pkt.optString("k");
        switch (k) {
            case "h": {
                p.userId = pkt.optString("u", "");
                p.net = pkt.optBoolean("net", false);
                p.since = pkt.optLong("since", 0);
                emitStatus();
                scheduleBridge(0); // появился сосед — возможно, ему надо что-то доставить
                break;
            }
            case "i": {
                JSONArray ids = pkt.optJSONArray("ids");
                Set<String> theirs = new HashSet<>();
                JSONArray ackBack = new JSONArray();
                if (ids != null) for (int i = 0; i < ids.length(); i++) {
                    String id = ids.getString(i);
                    theirs.add(id);
                    p.sent.add(id); // у него это уже есть
                    if (store.isAcked(id)) ackBack.put(id);
                }
                if (ackBack.length() > 0) { JSONObject a = new JSONObject(); a.put("k", "a"); a.put("ids", ackBack); send(p, a); }
                for (AirPinStore.Entry e : store.pendingForNetwork()) {
                    if (!theirs.contains(e.id)) sendEnvelope(p, e);
                }
                break;
            }
            case "e": {
                JSONObject env = pkt.getJSONObject("e");
                String id = env.getString("id");
                if (id.length() < 8 || id.length() > 64) return;
                p.sent.add(id);
                if (store.knows(id)) return;
                int ttl = env.optInt("ttl", 0) - 1;
                env.put("ttl", Math.max(ttl, 0));
                if (!store.put(id, env.toString(), false)) return;
                emit("env", env.toString()); // страница попробует расшифровать (если она в этом чате)
                if (ttl > 0) floodEnvelope(id, p.endpointId);
                scheduleBridge(0);
                emitStatus();
                break;
            }
            case "a": {
                JSONArray ids = pkt.optJSONArray("ids");
                if (ids == null) return;
                JSONArray fresh = new JSONArray();
                for (int i = 0; i < ids.length(); i++) if (store.ack(ids.getString(i))) fresh.put(ids.getString(i));
                if (fresh.length() > 0) {
                    broadcastAck(fresh, p.endpointId);
                    emit("ack", fresh.toString());
                    emitStatus();
                }
                break;
            }
            default: break;
        }
    }

    private void sendEnvelope(Peer p, AirPinStore.Entry e) {
        try {
            if (p.sent.contains(e.id)) return;
            JSONObject pkt = new JSONObject();
            pkt.put("k", "e");
            pkt.put("e", new JSONObject(e.envelope));
            if (send(p, pkt)) p.sent.add(e.id);
        } catch (Exception ignored) { }
    }

    private void floodEnvelope(String id, @Nullable String exceptEndpoint) {
        AirPinStore.Entry e = store.get(id);
        if (e == null || store.isAcked(id)) return;
        for (Peer p : peers.values()) {
            if (!p.connected || p.endpointId.equals(exceptEndpoint)) continue;
            sendEnvelope(p, e);
        }
    }

    private void broadcastAck(JSONArray ids, @Nullable String exceptEndpoint) {
        try {
            JSONObject a = new JSONObject();
            a.put("k", "a"); a.put("ids", ids);
            for (Peer p : peers.values()) if (p.connected && !p.endpointId.equals(exceptEndpoint)) send(p, a);
        } catch (Exception ignored) { }
    }

    // ---------- мост: интернет <-> mesh ----------

    private boolean hasInternet() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) { return false; }
    }

    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            netCallback = new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(@NonNull Network network) { onNetChanged(); }
                @Override public void onLost(@NonNull Network network) { onNetChanged(); }
                @Override public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities caps) { onNetChanged(); }
            };
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception ignored) { }
    }

    private void onNetChanged() {
        main.post(() -> {
            // Сообщаем соседям, есть ли у нас теперь интернет (меняется роль «мост»).
            for (Peer p : peers.values()) if (p.connected) sendHello(p);
            emitStatus();
            scheduleBridge(500);
        });
    }

    private void scheduleBridge(long delayMs) {
        if (!running) return;
        main.postDelayed(() -> io.execute(this::bridgeOnce), delayMs);
    }

    /** Периодический таймер: обслуживание хранилища, опрос сервера для соседей без интернета. */
    private void tick() {
        if (!running) return;
        io.execute(() -> { store.sweep(); bridgeOnce(); });
        main.postDelayed(this::tick, BRIDGE_POLL_MS);
    }

    private void bridgeOnce() {
        if (!running || !hasInternet()) return;
        if (!bridging.compareAndSet(false, true)) return;
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String serverUrl = prefs.getString(KEY_SERVER_URL, null);
            if (serverUrl == null || serverUrl.isEmpty()) return;
            String cookie = CookieManager.getInstance().getCookie(serverUrl);
            if (cookie == null || cookie.isEmpty()) return; // не залогинены — моста нет

            JSONArray envs = new JSONArray();
            for (AirPinStore.Entry e : store.pendingForNetwork()) {
                if (envs.length() >= 100) break;
                // Свои же downlink-конверты на сервер не возвращаем (id = id сообщения на сервере).
                JSONObject eo = new JSONObject(e.envelope);
                if (eo.optInt("dl", 0) == 1) continue;
                envs.put(eo);
            }
            JSONArray peerArr = new JSONArray();
            Set<String> seenUsers = new HashSet<>();
            for (Peer p : peers.values()) {
                if (!p.connected || p.net || p.userId.isEmpty() || !seenUsers.add(p.userId)) continue;
                JSONObject po = new JSONObject();
                Long local = peerSince.get(p.userId);
                po.put("u", p.userId);
                po.put("since", Math.max(p.since, local == null ? 0 : local));
                peerArr.put(po);
            }
            if (envs.length() == 0 && peerArr.length() == 0) return;

            JSONObject body = new JSONObject();
            body.put("envelopes", envs);
            body.put("peers", peerArr);
            String base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
            Request req = new Request.Builder()
                    .url(base + "api/airpin/ingest")
                    .header("Cookie", cookie)
                    .post(RequestBody.create(body.toString(), JSON_TYPE))
                    .build();
            try (Response resp = http.newCall(req).execute()) {
                if (!resp.isSuccessful() || resp.body() == null) return;
                JSONObject res = new JSONObject(resp.body().string());
                handleBridgeResponse(res);
            }
        } catch (Exception ignored) {
        } finally {
            bridging.set(false);
        }
    }

    private void handleBridgeResponse(JSONObject res) {
        final JSONArray acked = new JSONArray();
        JSONObject results = res.optJSONObject("results");
        if (results != null) {
            java.util.Iterator<String> it = results.keys();
            while (it.hasNext()) {
                String id = it.next();
                // ok / dup / rejected:* — в любом случае сервер этот конверт разобрал, повторять не надо
                if (store.ack(id)) acked.put(id);
            }
        }
        final JSONArray deliver = res.optJSONArray("deliver");
        main.post(() -> {
            if (acked.length() > 0) {
                broadcastAck(acked, null);
                emit("ack", acked.toString());
            }
            if (deliver != null) {
                for (int i = 0; i < deliver.length(); i++) {
                    try {
                        JSONObject env = deliver.getJSONObject(i);
                        String id = env.getString("id");
                        long t = env.optLong("t", 0);
                        for (Peer p : peers.values()) {
                            if (p.userId.isEmpty()) continue;
                            Long cur = peerSince.get(p.userId);
                            if (cur == null || t > cur) peerSince.put(p.userId, t);
                        }
                        if (store.put(id, env.toString(), false)) {
                            emit("env", env.toString());
                            floodEnvelope(id, null);
                        }
                    } catch (Exception ignored) { }
                }
            }
            emitStatus();
        });
    }

    // ---------- события и уведомление ----------

    private void emit(String type, String json) {
        Sink s = sink;
        if (s != null) { try { s.onEvent(type, json); } catch (Exception ignored) { } }
    }

    private void emitStatus() { emit("status", statusJson()); }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "AirPin", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Связь без интернета через ближайшие устройства");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(this, 0, open,
                android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("AirPin включён")
                .setContentText("Сообщения передаются через ближайшие устройства")
                .setOngoing(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
