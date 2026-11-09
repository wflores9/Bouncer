// Flood and duplicate-spam detection. Pure (no Discord calls).
import { normalizeText } from './normalize.js';

const LINKISH = /https?:\/\/|discord\.gg\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i;

function key(content) {
  return normalizeText(content).replace(/\s+/g, ' ').trim();
}

export class FloodWatch {
  constructor({ windowSeconds, maxMessages, dupWindowSeconds, maxDuplicates, crossChannelLimit }) {
    this.windowMs = windowSeconds * 1000;
    this.max = maxMessages;
    this.dupMs = dupWindowSeconds * 1000;
    this.maxDup = maxDuplicates;
    this.crossLimit = crossChannelLimit;
    this.history = new Map(); // userId -> [{ at, channelId, messageId, key, link }]
  }

  /**
   * Record one message.
   * @returns {{ verdict: 'none'|'flood'|'duplicate', reason?: string, messages: {channelId:string,messageId:string}[] }}
   */
  record({ userId, channelId, messageId, content = '', now = Date.now() }) {
    const keep = Math.max(this.windowMs, this.dupMs);
    const list = (this.history.get(userId) ?? []).filter((m) => now - m.at <= keep);
    const k = key(content);
    list.push({ at: now, channelId, messageId, key: k, link: LINKISH.test(content) });
    this.history.set(userId, list);

    const refs = (arr) => arr.map(({ channelId: c, messageId: m }) => ({ channelId: c, messageId: m }));

    const recent = list.filter((m) => now - m.at <= this.windowMs);
    if (recent.length >= this.max) {
      this.history.delete(userId);
      return { verdict: 'flood', reason: `${recent.length} messages in ${this.windowMs / 1000}s`, messages: refs(recent) };
    }

    // Short stuff like "gm" or "lol" repeated is just chat.
    if (k.length >= 12) {
      const same = list.filter((m) => m.key === k && now - m.at <= this.dupMs);
      const channels = new Set(same.map((m) => m.channelId)).size;
      const hasLink = same.some((m) => m.link);
      if (same.length >= this.maxDup || channels >= this.crossLimit || (hasLink && channels >= 2)) {
        this.history.delete(userId);
        return {
          verdict: 'duplicate',
          reason: `same message ${same.length}x across ${channels} channel${channels === 1 ? '' : 's'}`,
          messages: refs(same),
        };
      }
    }
    return { verdict: 'none', messages: [] };
  }

  /** Drop idle users so memory stays flat. */
  sweep(now = Date.now()) {
    const keep = Math.max(this.windowMs, this.dupMs);
    for (const [user, list] of this.history) {
      if (!list.length || now - list[list.length - 1].at > keep) this.history.delete(user);
    }
  }
}
