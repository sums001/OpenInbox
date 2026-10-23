// Generic SMTP over Workers TCP sockets: port 465 (implicit TLS) or 587 (STARTTLS), AUTH PLAIN or
// LOGIN. Cloudflare blocks outbound port 25, so it is refused here too. The message goes out as
// the raw MIME the send pipeline built, so threading headers are exactly ours.
import { connect as cfConnect } from 'cloudflare:sockets';
import { ProviderError, type DomainSetup, type OutgoingMessage, type ProviderAdapter, type SendResult } from './types';

export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  password: string;
}

type ConnectFn = typeof cfConnect;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT = 20_000;

class SmtpIo {
  private buffer = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        return line;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('SMTP server timed out.', true)), TIMEOUT);
      });
      const { value, done } = await Promise.race([this.reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (done) throw new ProviderError('SMTP server closed the connection.', true);
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (line.length < 4 || line[3] !== '-') {
        return { code: parseInt(line.slice(0, 3), 10), text: lines.map((l) => l.slice(4)).join('\n') };
      }
    }
  }

  async write(data: string): Promise<void> {
    await this.writer.write(encoder.encode(data));
  }

  async command(line: string, expect: number[], redact = false): Promise<{ code: number; text: string }> {
    await this.write(line + '\r\n');
    const r = await this.reply();
    if (!expect.includes(r.code)) {
      const shown = redact ? line.split(' ')[0] + ' ...' : line;
      throw new ProviderError(`SMTP ${shown} failed: ${r.code} ${r.text}`, r.code >= 400 && r.code < 500, r.code);
    }
    return r;
  }
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...encoder.encode(s)));
}

// Lines starting with "." get an extra "." (RFC 5321 section 4.5.2).
export function dotStuff(raw: string): string {
  return raw.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

export async function smtpSession(
  cfg: SmtpConfig,
  heloName: string,
  work: (io: SmtpIo) => Promise<string | null>,
  connect: ConnectFn = cfConnect,
): Promise<string | null> {
  if (cfg.port === 25) throw new ProviderError('Port 25 is blocked on Cloudflare Workers. Use 587 or 465.');
  let socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.security === 'tls' ? 'on' : 'starttls', allowHalfOpen: false });
  let io = new SmtpIo(socket);
  try {
    const greeting = await io.reply();
    if (greeting.code !== 220) throw new ProviderError(`SMTP server refused the connection: ${greeting.code} ${greeting.text}`, true);
    let ehlo = await io.command(`EHLO ${heloName}`, [250]);
    if (cfg.security === 'starttls') {
      if (!/^STARTTLS$/im.test(ehlo.text)) throw new ProviderError('The SMTP server does not offer STARTTLS on this port.');
      await io.command('STARTTLS', [220]);
      io.release();
      socket = socket.startTls();
      io = new SmtpIo(socket);
      ehlo = await io.command(`EHLO ${heloName}`, [250]);
    }
    if (cfg.username) {
      const methods = (/^AUTH[ =](.*)$/im.exec(ehlo.text)?.[1] ?? '').toUpperCase();
      if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
        await io.command(`AUTH PLAIN ${b64(`\u0000${cfg.username}\u0000${cfg.password}`)}`, [235], true);
      } else {
        await io.command('AUTH LOGIN', [334]);
        await io.command(b64(cfg.username), [334], true);
        await io.command(b64(cfg.password), [235], true);
      }
    }
    const result = await work(io);
    await io.command('QUIT', [221]).catch(() => undefined);
    return result;
  } finally {
    try {
      await socket.close();
    } catch {
      // already closed
    }
  }
}

export class SmtpAdapter implements ProviderAdapter {
  readonly type = 'smtp' as const;

  constructor(
    private config: SmtpConfig,
    private connect: ConnectFn = cfConnect,
  ) {}

  async validate() {
    await smtpSession(this.config, 'openinbox.invalid', async () => null, this.connect);
    return { account: `${this.config.username || 'anonymous'}@${this.config.host}:${this.config.port}` };
  }

  // SMTP has no domain API: the user publishes their provider's SPF/DKIM records, and the
  // domain health page checks them.
  async addDomain(): Promise<DomainSetup> {
    return { externalId: null, status: 'verified', records: [], message: "Publish your SMTP provider's SPF and DKIM records for this domain." };
  }

  async checkDomain(): Promise<DomainSetup> {
    return this.addDomain();
  }

  async send(m: OutgoingMessage): Promise<SendResult> {
    const recipients = [...m.to, ...m.cc, ...m.bcc].map((a) => a.address);
    // Addresses go into SMTP command lines: whitespace, control characters or angle brackets
    // would end the command early and let the rest run as commands of its own.
    const unsafe = [m.from.address, ...recipients].find((a) => !/^[^\s\p{Cc}<>]+@[^\s\p{Cc}<>]+$/u.test(a));
    if (unsafe !== undefined) throw new ProviderError('An address contains characters SMTP cannot carry.', false);
    const helo = m.from.address.split('@')[1] || 'localhost';
    const id = await smtpSession(
      this.config,
      helo,
      async (io) => {
        await io.command(`MAIL FROM:<${m.from.address}>`, [250]);
        for (const r of recipients) await io.command(`RCPT TO:<${r}>`, [250, 251]);
        await io.command('DATA', [354]);
        const body = dotStuff(m.raw);
        await io.write(body.endsWith('\r\n') ? `${body}.\r\n` : `${body}\r\n.\r\n`);
        const done = await io.reply();
        if (done.code !== 250) throw new ProviderError(`SMTP DATA failed: ${done.code} ${done.text}`, done.code >= 400 && done.code < 500, done.code);
        return /(?:queued as|id=)\s*([\w.-]+)/i.exec(done.text)?.[1] ?? null;
      },
      this.connect,
    );
    return { providerMessageId: id };
  }
}
