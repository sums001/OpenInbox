// Phones connected to this account: the OpenInbox app, connected by scanning a QR code shown here
// (services/devices.ts on the server). The phone never sees the password, and a code is useless
// until the person allows the phone that claimed it.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderSVG } from 'uqr';
import { CircleCheck, CircleX, Smartphone, Trash } from 'lucide-react';
import { del, get, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useAction, useInterval } from '../lib/hooks';
import { Button } from './ui/button';
import { Card, CardHeader, CopyButton } from './ui/misc';
import { Dialog } from './ui/overlay';

interface Device {
  id: number;
  name: string;
  platform: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
}
interface Pairing {
  id: number;
  url: string;
  shortCode: string;
  expiresAt: number;
}
interface PairingState {
  status: 'waiting' | 'claimed' | 'approved' | 'denied' | 'expired';
  deviceName: string | null;
  platform: string | null;
  expiresAt: number | null;
}

// A browser names itself ("Browser on Linux"), so only phones get a platform after the name.
const PLATFORMS: Record<string, string> = { android: 'Android', ios: 'iPhone or iPad' };

export function Phones() {
  const q = useQuery({ queryKey: ['devices'], queryFn: () => get<Device[]>('/account/devices') });
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const { run, busy } = useAction();
  const start = () => run('pair', async () => setPairing(await post<Pairing>('/account/devices/pairing')));
  return (
    <Card>
      <CardHeader
        icon={<Smartphone className="h-5 w-5" />}
        title="Phones"
        description="The OpenInbox app. Connect it by scanning a code; your password never goes into the app."
        action={
          <Button size="sm" variant="primary" loading={busy === 'pair'} onClick={start}>
            Connect a phone
          </Button>
        }
      />
      {q.data?.length ? (
        <div className="divide-y divide-border">
          {q.data.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {d.name}
                  {d.platform && PLATFORMS[d.platform] && <span className="font-normal text-muted"> · {PLATFORMS[d.platform]}</span>}
                </div>
                <div className="text-xs text-muted">
                  {d.lastUsedAt ? `active ${timeAgo(d.lastUsedAt)}${d.lastUsedIp ? ` from ${d.lastUsedIp}` : ''}` : 'not used yet'} · connected {timeAgo(d.createdAt)}
                </div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                icon={<Trash className="h-3.5 w-3.5" />}
                loading={busy === `rm${d.id}`}
                onClick={() => run(`rm${d.id}`, () => del(`/account/devices/${d.id}`).then(() => q.refetch()), `${d.name} disconnected`)}
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-5 py-4 text-sm text-muted">{q.isLoading ? 'Loading…' : 'No phones connected.'}</div>
      )}
      {pairing && <PairDialog key={pairing.id} pairing={pairing} onClose={() => setPairing(null)} onNewCode={start} onConnected={() => q.refetch()} />}
    </Card>
  );
}

type View = 'waiting' | 'claimed' | 'allowed' | 'denied' | 'expired';

function PairDialog({ pairing, onClose, onNewCode, onConnected }: { pairing: Pairing; onClose: () => void; onNewCode: () => void; onConnected: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [decided, setDecided] = useState<'allowed' | 'denied' | null>(null);
  const { run, busy } = useAction();
  // Ask every 2 seconds whether a phone has claimed the code, until it's decided or gone.
  const q = useQuery({
    queryKey: ['pairing', pairing.id],
    queryFn: () => get<PairingState>(`/account/devices/pairing/${pairing.id}`),
    refetchInterval: (query) => (decided || ['denied', 'expired'].includes(query.state.data?.status ?? '') ? false : 2000),
  });
  useInterval(() => setNow(Date.now()), decided ? null : 1000);

  const state = q.data;
  const left = Math.max(0, Math.ceil(((state?.expiresAt ?? pairing.expiresAt) - now) / 1000));
  const server = new URL(pairing.url).searchParams.get('server') ?? location.origin;
  const view: View = decided ?? (state?.status === 'approved' ? 'allowed' : left === 0 ? 'expired' : (state?.status ?? 'waiting'));
  const name = state?.deviceName ?? 'A phone';
  const platform = state?.platform && PLATFORMS[state.platform] ? ` (${PLATFORMS[state.platform]})` : '';
  const decide = (allow: boolean) =>
    run(allow ? 'allow' : 'deny', async () => {
      await post(`/account/devices/pairing/${pairing.id}`, { allow });
      setDecided(allow ? 'allowed' : 'denied');
      if (allow) onConnected();
    });

  const titles: Record<View, string> = {
    waiting: 'Connect a phone',
    claimed: 'Allow this phone?',
    allowed: 'Phone connected',
    denied: 'Phone not connected',
    expired: 'This code expired',
  };
  const footers: Record<View, ReactNode> = {
    waiting: <Button onClick={onClose}>Cancel</Button>,
    claimed: (
      <>
        <Button variant="outline" loading={busy === 'deny'} onClick={() => decide(false)}>
          Deny
        </Button>
        <Button variant="primary" loading={busy === 'allow'} onClick={() => decide(true)}>
          Allow
        </Button>
      </>
    ),
    allowed: (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    ),
    denied: <Button onClick={onClose}>Close</Button>,
    expired: (
      <Button variant="primary" onClick={onNewCode}>
        Get a new code
      </Button>
    ),
  };

  return (
    <Dialog open onClose={onClose} title={titles[view]} footer={footers[view]} size="sm">
      {view === 'waiting' && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Open the OpenInbox app on your phone, tap <span className="font-medium text-fg">Scan QR code</span> and point the camera at this code.
          </p>
          <div
            role="img"
            aria-label="QR code for the OpenInbox app"
            className="mx-auto w-52 rounded-lg bg-white p-2"
            dangerouslySetInnerHTML={{ __html: renderSVG(pairing.url, { border: 1 }) }}
          />
          <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-center text-xs text-muted">
            <div>No camera? In the app, tap Type a code and enter</div>
            <div>
              server <span className="font-mono text-fg">{server.replace(/^https:\/\//, '')}</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              code <span className="font-mono text-base tracking-wider text-fg">{pairing.shortCode}</span> <CopyButton text={pairing.shortCode} />
            </div>
          </div>
          <div className="text-center text-xs text-faint" aria-live="polite">
            Works once. Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </div>
        </div>
      )}
      {view === 'claimed' && (
        <div className="space-y-3 text-center">
          <Smartphone className="mx-auto h-10 w-10 text-primary" />
          <div className="text-base font-medium text-fg">
            {name}
            {platform} wants to connect
          </div>
          <p className="text-sm text-muted">
            It will be able to read, send and organize your mail. Allow it only if it's your phone and you scanned this code just now.
          </p>
        </div>
      )}
      {view === 'allowed' && (
        <div className="space-y-3 text-center">
          <CircleCheck className="mx-auto h-10 w-10 text-success" />
          <div className="text-base font-medium text-fg">{name} is connected</div>
          <p className="text-sm text-muted">It's listed under Phones. Disconnect it there at any time.</p>
        </div>
      )}
      {view === 'denied' && (
        <div className="space-y-3 text-center">
          <CircleX className="mx-auto h-10 w-10 text-danger" />
          <p className="text-sm text-muted">The phone was turned away and can't use this code again.</p>
        </div>
      )}
      {view === 'expired' && <p className="text-sm text-muted">Codes work for 5 minutes. Get a new one and scan it again.</p>}
    </Dialog>
  );
}
