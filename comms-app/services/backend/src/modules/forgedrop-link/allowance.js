/**
 * How often the person relay may email someone (ForgeDrop/docs/people.md): at
 * most one email per sender and recipient account every `everyMs`, and
 * `perHour` an hour per recipient account, from anyone. A waiting send's
 * email (people.js) and a request's (requests.js) each keep an allowance of
 * their own, so neither uses up the other's. In memory, like everything else
 * here.
 */

const HOUR_MS = 60 * 60_000;

export function createEmailAllowance({ now = Date.now, everyMs, perHour }) {
  /** "sender recipient" accounts -> when the last email between them went */
  const lastEmail = new Map();
  /** recipient account -> when its emails of the last hour went */
  const emails = new Map();

  return {
    /** Whether an email may go now; if so, it is counted. */
    may(fromUserId, toUserId) {
      const at = now();
      const pair = `${fromUserId} ${toUserId}`;
      if (at - (lastEmail.get(pair) ?? -Infinity) < everyMs) return false;
      const recent = (emails.get(toUserId) ?? []).filter((when) => at - when < HOUR_MS);
      if (recent.length >= perHour) {
        emails.set(toUserId, recent);
        return false;
      }
      recent.push(at);
      emails.set(toUserId, recent);
      lastEmail.set(pair, at);
      return true;
    },

    /** Forget what no longer counts. */
    sweep() {
      const at = now();
      for (const [pair, when] of lastEmail) if (at - when >= everyMs) lastEmail.delete(pair);
      for (const [userId, times] of emails) {
        const recent = times.filter((when) => at - when < HOUR_MS);
        if (recent.length) emails.set(userId, recent);
        else emails.delete(userId);
      }
    },
  };
}
