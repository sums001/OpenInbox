// Local mock of the external APIs (Cloudflare, Resend, Brevo, Mailjet, GitHub) on port 8790.
// Used by `npm run dev:mock` and the Playwright tests. Run with Node 22.18+ (type stripping).
import { createServer } from 'node:http';
import { createFakeState, handleFake } from './fake-apis.ts';

const port = Number(process.env.MOCK_PORT ?? 8790);
let state = createFakeState();

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = `http://127.0.0.1:${port}${req.url}`;
  if (req.url === '/__mock/reset') {
    state = createFakeState();
    res.writeHead(200).end('{"ok":true}');
    return;
  }
  if (req.url === '/__mock/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
    return;
  }
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : v ? [[k, v] as [string, string]] : [])),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = (await handleFake(state, request)) ?? new Response('{"error":"not mocked"}', { status: 404 });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, '127.0.0.1', () => console.log(`OpenInbox mock APIs on http://127.0.0.1:${port}`));
