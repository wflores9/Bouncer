// Xaman sign-in (wallet linking). Bouncer only ever creates "SignIn" requests:
// they prove someone controls an address and can't move funds or set trustlines.
const API = 'https://xumm.app/api/v1/platform';

export class Xaman {
  constructor(apiKey, apiSecret, fetchImpl = globalThis.fetch) {
    this.key = apiKey;
    this.secret = apiSecret;
    this.fetch = fetchImpl;
  }

  get enabled() { return Boolean(this.key && this.secret); }

  async call(path, init = {}) {
    const res = await this.fetch(`${API}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'x-api-secret': this.secret },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Xaman ${res.status}: ${body?.error?.code ?? body?.error ?? 'request failed'}`);
    return body;
  }

  /** @returns {{uuid:string, link:string, qr:string}} */
  async createSignIn(identifier, instruction) {
    const p = await this.call('/payload', {
      method: 'POST',
      body: JSON.stringify({
        txjson: { TransactionType: 'SignIn' },
        options: { expire: 5, submit: false },
        custom_meta: { identifier, instruction },
      }),
    });
    return { uuid: p.uuid, link: p.next.always, qr: p.refs.qr_png };
  }

  async status(uuid) {
    const p = await this.call(`/payload/${uuid}`);
    return {
      resolved: Boolean(p.meta?.resolved),
      signed: Boolean(p.meta?.signed),
      expired: Boolean(p.meta?.expired),
      account: p.response?.account ?? null,
      txType: p.payload?.tx_type ?? null,
    };
  }

  /** Poll until signed, declined or expired. */
  async waitForSignIn(uuid, { timeoutMs = 5.5 * 60_000, intervalMs = 3000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await this.status(uuid).catch(() => null);
      if (s && (s.resolved || s.expired)) return s;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { resolved: false, signed: false, expired: true, account: null };
  }
}
