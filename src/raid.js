// Sliding-window join counter. Trips "raid mode" when too many people join too fast.
export class RaidWatch {
  constructor({ joins, windowSeconds, durationMinutes }) {
    this.limit = joins;
    this.windowMs = windowSeconds * 1000;
    this.durationMs = durationMinutes * 60 * 1000;
    this.stamps = [];
    this.activeUntil = 0;
    this.manual = false;
  }

  /** Record a join. Returns true only on the join that starts a new raid. */
  record(now = Date.now()) {
    this.stamps.push(now);
    this.stamps = this.stamps.filter((t) => now - t <= this.windowMs);
    if (this.stamps.length >= this.limit && !this.isActive(now)) {
      this.activeUntil = now + this.durationMs;
      return true;
    }
    if (this.isActive(now) && this.stamps.length >= this.limit) {
      this.activeUntil = now + this.durationMs; // keep extending while joins continue
    }
    return false;
  }

  isActive(now = Date.now()) {
    return this.manual || now < this.activeUntil;
  }

  set(on) {
    this.manual = on;
    if (!on) this.activeUntil = 0;
  }
}
