import { get, post } from './api';

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

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return false;
  }

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/account/push/vapid-public-key');

  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await existing.unsubscribe().catch(() => undefined);
  }

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
  });

  const p256dhKey = subscription.getKey('p256dh');
  const authKey = subscription.getKey('auth');
  if (!p256dhKey || !authKey) {
    throw new Error('Failed to retrieve cryptographic keys from device push subscription.');
  }

  const p256dh = toBase64Url(new Uint8Array(p256dhKey));
  const auth = toBase64Url(new Uint8Array(authKey));

  await post('/account/push/subscribe', {
    endpoint: subscription.endpoint,
    p256dh,
    auth,
  });

  return true;
}

export async function unsubscribeFromPush(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
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
