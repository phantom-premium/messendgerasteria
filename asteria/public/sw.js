'use strict';
// Service Worker — единственный способ получить уведомление в закрытом
// Safari/PWA на iOS (и в фоне любого другого браузера). Обычный
// `new Notification()` из app.js работает только пока вкладка/PWA реально
// открыта и её JS жив — здесь же события 'push' система доставляет
// операционной системе даже когда сайт нигде не запущен.
//
// ВАЖНО про iOS: push для PWA, установленных на экран «Домой», работает
// только начиная с iOS/iPadOS 16.4 и ТОЛЬКО если сайт добавлен на главный
// экран через Safari (обычная открытая вкладка Safari получать push не
// умеет, даже если разрешение на уведомления выдано).

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* пустой/не-JSON пейлоад — покажем заглушку */ }

  // "Отбой": сервер прислал это, когда звонок уже закончился/принят на
  // другом устройстве раньше, чем мы вообще успели показать уведомление —
  // закрываем то, что показывали (по тому же tag), новое не показываем.
  // См. cancelWebPushForCall() в server.js.
  if (data.cancelCall) {
    const existing = await self.registration.getNotifications({ tag: data.tag });
    existing.forEach((n) => n.close());
    return;
  }

  const title = data.title || 'Asteria';
  const body = data.body || '';
  const tag = data.tag || undefined;
  const conversationId = data.conversationId || null;
  const url = data.url || '/';

  // Если у пользователя ПРЯМО СЕЙЧАС открыта и видна вкладка/PWA — она уже
  // покажет уведомление сама через notifyNewMessage() в app.js (обычный
  // Notification API), а входящий звонок — собственным полноэкранным
  // экраном. Показывать системный push поверх — значит показать одно и то
  // же дважды. Проверяем через Clients API: есть ли сфокусированное
  // видимое окно.
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const alreadyVisible = clientsList.some((c) => c.focused && c.visibilityState === 'visible');
  if (alreadyVisible) return;

  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Звонок — более настойчивое уведомление, чем обычное сообщение:
    // requireInteraction просит систему не убирать его самостоятельно
    // (насколько это вообще уважает конкретная версия iOS — но хуже не
    // будет), vibrate — по аналогии с вибрацией звонка на Android
    // (см. showCallNotification в AsteriaPushService.java).
    requireInteraction: !!data.isCall,
    vibrate: data.isCall ? [500, 300, 500, 300, 500] : undefined,
    data: { url, conversationId, isCall: !!data.isCall },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url) {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clientsList) {
    if ('focus' in c) {
      try { if ('navigate' in c) await c.navigate(url); } catch (e) { /* игнорируем — просто сфокусируем как есть */ }
      return c.focus();
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}
