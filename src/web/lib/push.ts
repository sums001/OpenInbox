import { get, post } from './api';
import { storageGet, storageSet } from './utils';

// 'oi.push': this browser has a push subscription, so the in-page notification stands down
// (pages/mail/data.ts). 'oi.push.synced': the endpoint last sent to the server, and when.
const DAY = 86_400_000;

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIosDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (('standalone' in navigator) && !!(navigator as unknown as { standalone?: boolean }).standalone)
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// The service worker is registered only when someone turns push on, so most pages never have
// one. getRegistration() answers either way, where serviceWorker.ready would wait forever.
const registration = () => navigator.serviceWorker.getRegistration('/');

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function keysOf(subscription: PushSubscription) {
  const p256dhKey = subscription.getKey('p256dh');
  const authKey = subscription.getKey('auth');
  if (!p256dhKey || !authKey) throw new Error('Failed to retrieve cryptographic keys from device push subscription.');
  return { endpoint: subscription.endpoint, p256dh: toBase64Url(new Uint8Array(p256dhKey)), auth: toBase64Url(new Uint8Array(authKey)) };
}

async function sendToServer(subscription: PushSubscription): Promise<void> {
  await post('/account/push/subscribe', keysOf(subscription));
  storageSet('oi.push', true);
  storageSet('oi.push.synced', { endpoint: subscription.endpoint, at: Date.now() });
}

async function newSubscription(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const { publicKey } = await get<{ publicKey: string }>('/account/push/vapid-public-key');
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource });
}

// On each app load, for a browser that has push on: keeps the server's copy of this device's
// subscription current. Browsers replace subscriptions now and then (the service worker
// re-subscribes on pushsubscriptionchange) or drop them; without this, notifications would stop
// with no sign why. Sends at most once a day unless the endpoint changed.
export async function syncPushSubscription(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await registration();
  if (!reg) {
    storageSet('oi.push', false);
    return;
  }
  reg.update().catch(() => undefined);
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription && storageGet('oi.push', false) && Notification.permission === 'granted') subscription = await newSubscription(reg);
  if (!subscription) {
    storageSet('oi.push', false);
    return;
  }
  const last = storageGet<{ endpoint: string; at: number } | null>('oi.push.synced', null);
  if (last?.endpoint === subscription.endpoint && Date.now() - last.at < DAY) {
    storageSet('oi.push', true);
    return;
  }
  await sendToServer(subscription);
}

export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return false;
  }

  await navigator.serviceWorker.register('/sw.js');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await existing.unsubscribe().catch(() => undefined);
  }
  await sendToServer(await newSubscription(reg));
  return true;
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  storageSet('oi.push', false);
  storageSet('oi.push.synced', null);
  const reg = await registration();
  const subscription = reg ? await reg.pushManager.getSubscription() : null;
  if (subscription) {
    await post('/account/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return true;
}

export async function sendTestNotification(): Promise<number> {
  const res = await post<{ ok: boolean; sent: number }>('/account/push/test');
  return res.sent;
}
