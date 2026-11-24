// The relay Worker OpenInbox installs in another Cloudflare account, for domains whose zone sits
// there: Email Routing only hands mail to a Worker in the zone's own account. It passes each
// message to OpenInbox over HTTPS and carries out the answer (reject, or forward copies).
// OpenInbox uploads this file as it is (services/relay.ts), so it stays plain JavaScript with no
// imports. Bindings: OPENINBOX_URL, ACCOUNT_ID, RELAY_SECRET.
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(`${env.OPENINBOX_URL}/api/relay/${env.ACCOUNT_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RELAY_SECRET}`,
        'Content-Type': 'message/rfc822',
        'X-Envelope-From': encodeURIComponent(message.from || ''),
        'X-Envelope-To': encodeURIComponent(message.to),
      },
      body: raw,
    });
    // Anything but an answer makes Email Routing report a temporary failure, so the sending
    // server tries again later instead of the message being lost.
    if (!res.ok) throw new Error(`OpenInbox answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const answer = await res.json();
    if (answer.reject) {
      message.setReject(answer.reject);
      return;
    }
    for (const to of answer.forward || []) {
      try {
        await message.forward(to);
      } catch (e) {
        // The address must be a verified destination in this account too.
        console.error(`Forwarding to ${to} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  },
};
