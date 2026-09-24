/**
 * Circle change notifications.
 *
 * Every change appends a row to rts_events inside the same transaction and
 * moves the circle's `seq` forward. After the transaction commits, the hub
 * tells any open app streams for that circle that a newer seq exists; the app
 * then fetches its own view of the circle, so nothing secret travels on the
 * stream itself.
 *
 * The hub is in-process. SendForge runs one Render instance; with more, a
 * stream on another instance still catches up whenever the app reconnects or
 * comes back to the foreground, because it always asks for "anything after
 * the seq I have".
 */

import { EventEmitter } from "node:events";

export function createHub() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish(circleId, seq) {
      emitter.emit(String(circleId), Number(seq));
    },
    subscribe(circleId, listener) {
      const key = String(circleId);
      emitter.on(key, listener);
      return () => emitter.off(key, listener);
    },
    listenerCount(circleId) {
      return emitter.listenerCount(String(circleId));
    },
  };
}

/** Append an event and advance the circle's seq. Returns the new seq. */
export async function appendEvent(trx, { circleId, type, actorMemberId = null, data = {} }) {
  const [row] = await trx("rts_events")
    .insert({
      circle_id: circleId,
      type,
      actor_member_id: actorMemberId,
      data: JSON.stringify(data),
    })
    .returning(["seq"]);
  const seq = Number(row.seq);
  await trx("rts_circles").where({ id: circleId }).update({ seq, updated_at: trx.fn.now() });
  return seq;
}
