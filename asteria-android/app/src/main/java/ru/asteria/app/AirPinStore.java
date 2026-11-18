package ru.asteria.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AirPin: постоянное хранилище «отложенной отправки» (store-and-forward).
 *
 * Хранит конверты (JSON-строки, см. lib/airpin.js на сервере) как есть, не
 * понимая их содержимого — телефон-ретранслятор читать чужие сообщения не
 * может, они зашифрованы ключом чата. Также хранит список «подтверждённых»
 * id (сервер принял / получатель получил) — по ним конверты удаляются из
 * сети, а повторно уже не принимаются.
 *
 * Данные переживают перезапуск приложения: если рядом никого нет, конверты
 * лежат в файле и уходят дальше, как только в зоне действия появится
 * другой участник (или у телефона появится интернет и он станет мостом).
 */
final class AirPinStore {
    static final long ENVELOPE_TTL_MS = 72L * 3600 * 1000; // хранить конверт максимум 3 суток
    static final long ACK_TTL_MS = 14L * 24 * 3600 * 1000;
    static final int MAX_ENVELOPES = 500;
    static final int MAX_ACKS = 20000;

    static final class Entry {
        final String id;
        String envelope;       // JSON конверта (ttl хопов уже уменьшен)
        final long addedAt;
        boolean delivered;     // true — страница уже получила его (или он не нужен локально)
        Entry(String id, String envelope, long addedAt, boolean delivered) {
            this.id = id; this.envelope = envelope; this.addedAt = addedAt; this.delivered = delivered;
        }
    }

    private final File file;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final Map<String, Long> acked = new LinkedHashMap<>();
    private boolean dirty = false;
    private long lastSave = 0;

    AirPinStore(Context ctx) {
        file = new File(ctx.getFilesDir(), "airpin-store.json");
        load();
    }

    private synchronized void load() {
        try {
            if (!file.exists()) return;
            byte[] b = new byte[(int) file.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(file);
            try { int off = 0; while (off < b.length) { int r = in.read(b, off, b.length - off); if (r < 0) break; off += r; } } finally { in.close(); }
            JSONObject root = new JSONObject(new String(b, StandardCharsets.UTF_8));
            JSONArray es = root.optJSONArray("e");
            if (es != null) for (int i = 0; i < es.length(); i++) {
                JSONObject o = es.getJSONObject(i);
                entries.put(o.getString("id"), new Entry(o.getString("id"), o.getString("env"), o.optLong("at"), o.optBoolean("dl")));
            }
            JSONArray as = root.optJSONArray("a");
            if (as != null) for (int i = 0; i < as.length(); i++) {
                JSONArray p = as.getJSONArray(i);
                acked.put(p.getString(0), p.getLong(1));
            }
        } catch (Exception e) {
            entries.clear(); acked.clear(); // битый файл — начинаем с чистого листа
        }
    }

    synchronized void save(boolean force) {
        long now = System.currentTimeMillis();
        if (!dirty || (!force && now - lastSave < 2000)) return;
        try {
            JSONObject root = new JSONObject();
            JSONArray es = new JSONArray();
            for (Entry e : entries.values()) {
                JSONObject o = new JSONObject();
                o.put("id", e.id); o.put("env", e.envelope); o.put("at", e.addedAt); o.put("dl", e.delivered);
                es.put(o);
            }
            JSONArray as = new JSONArray();
            for (Map.Entry<String, Long> a : acked.entrySet()) {
                JSONArray p = new JSONArray(); p.put(a.getKey()); p.put(a.getValue());
                as.put(p);
            }
            root.put("e", es); root.put("a", as);
            File tmp = new File(file.getParentFile(), file.getName() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try { out.write(root.toString().getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); } finally { out.close(); }
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file); }
            dirty = false; lastSave = now;
        } catch (Exception ignored) { }
    }

    synchronized boolean knows(String id) { return entries.containsKey(id) || acked.containsKey(id); }
    synchronized boolean isAcked(String id) { return acked.containsKey(id); }

    /** @return true, если конверт новый и сохранён. */
    synchronized boolean put(String id, String envelope, boolean delivered) {
        if (knows(id)) return false;
        entries.put(id, new Entry(id, envelope, System.currentTimeMillis(), delivered));
        while (entries.size() > MAX_ENVELOPES) { // выкидываем самые старые
            Iterator<String> it = entries.keySet().iterator();
            it.next(); it.remove();
        }
        dirty = true; save(false);
        return true;
    }

    /** @return true, если ack новый. */
    synchronized boolean ack(String id) {
        boolean fresh = !acked.containsKey(id);
        if (fresh) {
            acked.put(id, System.currentTimeMillis());
            while (acked.size() > MAX_ACKS) { Iterator<String> it = acked.keySet().iterator(); it.next(); it.remove(); }
        }
        // Конверт ещё не отдан странице — оставляем его (хранится до подтверждения страницей),
        // но по сети он больше не пересылается. Поэтому удаляем только доставленные.
        Entry e = entries.get(id);
        if (e != null && e.delivered) entries.remove(id);
        dirty = true; save(false);
        return fresh;
    }

    synchronized void markDelivered(String id) {
        Entry e = entries.get(id);
        if (e == null) return;
        e.delivered = true;
        if (acked.containsKey(id)) entries.remove(id);
        dirty = true; save(false);
    }

    /** Конверты, которые ещё надо гнать по сети (не подтверждены). */
    synchronized List<Entry> pendingForNetwork() {
        List<Entry> out = new ArrayList<>();
        for (Entry e : entries.values()) if (!acked.containsKey(e.id)) out.add(e);
        return out;
    }

    synchronized List<Entry> undeliveredToPage() {
        List<Entry> out = new ArrayList<>();
        for (Entry e : entries.values()) if (!e.delivered) out.add(e);
        return out;
    }

    synchronized Entry get(String id) { return entries.get(id); }

    synchronized List<String> inventoryIds(int max) {
        List<String> ids = new ArrayList<>();
        for (Entry e : entries.values()) { if (!acked.containsKey(e.id)) ids.add(e.id); if (ids.size() >= max) break; }
        return ids;
    }

    synchronized int pendingCount() { return pendingForNetwork().size(); }

    synchronized void sweep() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Entry>> it = entries.entrySet().iterator();
        while (it.hasNext()) { if (now - it.next().getValue().addedAt > ENVELOPE_TTL_MS) { it.remove(); dirty = true; } }
        Iterator<Map.Entry<String, Long>> ai = acked.entrySet().iterator();
        while (ai.hasNext()) { if (now - ai.next().getValue() > ACK_TTL_MS) { ai.remove(); dirty = true; } }
        save(false);
    }
}
