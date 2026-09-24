/**
 * Romancing the Stone — circle rules.
 *
 * Words used here:
 *   circle   a couple, friends, family or team sharing one reward system
 *   keeper   sets quests and paths, approves claims, delivers rewards
 *   seeker   earns stones and walks paths ("both" is both)
 *   viewer   the signed-in person's own member record
 *   actor    who the request acts for: the viewer, or a managed profile (a
 *            child without an account) that a keeper is playing for
 *   stones   points; kept as a balance on the member with a ledger beside it
 *   key      a one-time pass to open a specific path, earned from a quest
 *   run      one walk down a path; its finished form is a treasure
 */

import { randomInt as cryptoRandomInt, randomUUID } from "node:crypto";
import * as engine from "./engine.js";
import { appendEvent } from "./events.js";
import { RTS_LIMITS } from "./config.js";

export class RtsError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const fail = (status, code, extra) => {
  throw new RtsError(status, code, extra);
};

export const isKeeper = (member) => member?.role === "keeper" || member?.role === "both";
export const canEarn = (member) => member?.role === "seeker" || member?.role === "both";

const idList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};
const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * A path's seekers: its assignees, or everyone who earns except its maker.
 * Nobody who has ever seen behind its doors can walk it.
 */
export function eligibleForPath(member, path) {
  if (!canEarn(member)) return false;
  if (idList(path.seen_by).includes(member.id)) return false;
  const assignees = idList(path.assignee_ids);
  return assignees.length ? assignees.includes(member.id) : member.id !== path.created_by_member;
}

/** Keepers who are not seekers on a path may see (and edit) what is behind it. */
export function canSeePathSecrets(member, path) {
  return isKeeper(member) && !eligibleForPath(member, path);
}

export function eligibleForQuest(member, quest) {
  if (!canEarn(member)) return false;
  const assignees = idList(quest.assignee_ids);
  return assignees.length ? assignees.includes(member.id) : member.id !== quest.created_by_member;
}

const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Which period a claim falls in, in the circle's own time zone. */
export function periodKey(recurrence, timezone, date = new Date()) {
  if (recurrence === "once") return "once";
  if (recurrence === "always") return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  if (recurrence === "daily") return `d:${parts.year}-${parts.month}-${parts.day}`;
  const monday = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) -
      (WEEKDAY[parts.weekday] ?? 0) * 86_400_000
  );
  return `w:${monday.toISOString().slice(0, 10)}`;
}

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeInviteCode(randomInt = cryptoRandomInt) {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

const defaultRole = (kind, joining) => {
  if (kind === "couple" || kind === "friends") return "both";
  return joining ? "seeker" : "keeper";
};

function memberView(member, viewer) {
  return {
    id: member.id,
    displayName: member.display_name,
    role: member.role,
    avatar: member.avatar,
    color: member.color,
    balance: Number(member.balance || 0),
    managed: !member.user_id,
    isViewer: member.id === viewer?.id,
  };
}

/**
 * Who may see what a walk ended in: the walker, the child profile a keeper is
 * playing for, and keepers who may see behind that path's doors. A path that
 * cannot be found (archived) is treated as secret.
 */
function rewardVisible(memberId, viewer, actor, path) {
  if (memberId === viewer.id || memberId === actor.id) return true;
  if (!isKeeper(viewer) || !path) return false;
  return canSeePathSecrets(viewer, path);
}

export function runView(run, { viewer, actor, path = null }) {
  const steps = json(run.steps) || [];
  const graph = json(run.graph);
  const own = run.member_id === actor.id || run.member_id === viewer.id;
  const showReward = run.status === "complete" && rewardVisible(run.member_id, viewer, actor, path);
  return {
    id: run.id,
    pathId: run.path_id,
    memberId: run.member_id,
    title: run.path_title,
    icon: run.path_icon,
    color: run.path_color,
    status: run.status,
    paidWith: run.paid_with,
    costPaid: Number(run.cost_paid || 0),
    startedAt: iso(run.started_at),
    completedAt: iso(run.completed_at),
    steps: own || showReward ? steps : [],
    current: run.status === "active" && run.member_id === actor.id ? engine.publicNode(graph, run.current_node) : null,
    reward: showReward ? json(run.reward) : null,
    rewardHidden: run.status === "complete" && !showReward,
    fulfillment: run.fulfillment || null,
    fulfillmentNote: run.fulfillment_note || "",
    fulfilledAt: iso(run.fulfilled_at),
    canFulfill: run.status === "complete" && isKeeper(viewer) && run.member_id !== viewer.id,
    canCancel: run.status === "active" && isKeeper(viewer) && run.member_id !== viewer.id,
  };
}

export function createRtsService({ db, hub, randomInt = cryptoRandomInt, now = () => new Date() }) {
  const publish = (circleId, seq) => {
    if (seq) hub?.publish(circleId, seq);
  };

  async function inTx(circleId, work) {
    let seq = 0;
    const result = await db.transaction(async (trx) => {
      // One writer per circle at a time: event seqs then reach the circle in
      // commit order, and rules that count members see a settled picture.
      await trx.raw("select id from rts_circles where id = ? for update", [circleId]);
      const emit = async (type, actorMemberId, data) => {
        seq = await appendEvent(trx, { circleId, type, actorMemberId, data });
        return seq;
      };
      return work(trx, emit);
    });
    publish(circleId, seq);
    return result;
  }

  async function activeMember(trx, circleId, memberId) {
    const member = await trx("rts_members").where({ id: memberId, circle_id: circleId }).whereNull("removed_at").first();
    if (!member) fail(404, "member_not_found");
    return member;
  }

  async function credit(trx, { circleId, member, amount, kind, note = "", refId = null, actorId = null }) {
    const [row] = await trx("rts_members")
      .where({ id: member.id })
      .whereNull("removed_at")
      .update({ balance: trx.raw("balance + ?", [amount]), updated_at: trx.fn.now() })
      .returning(["balance"]);
    if (!row) fail(409, "member_not_found");
    await trx("rts_ledger").insert({
      id: randomUUID(),
      circle_id: circleId,
      member_id: member.id,
      delta: amount,
      balance_after: row.balance,
      kind,
      note: String(note || "").slice(0, 200),
      ref_id: refId,
      actor_member_id: actorId,
    });
    return Number(row.balance);
  }

  async function debit(trx, { circleId, member, amount, kind, note = "", refId = null, actorId = null }) {
    const [row] = await trx("rts_members")
      .where({ id: member.id })
      .whereNull("removed_at")
      .andWhere("balance", ">=", amount)
      .update({ balance: trx.raw("balance - ?", [amount]), updated_at: trx.fn.now() })
      .returning(["balance"]);
    if (!row) fail(409, "not_enough_stones");
    await trx("rts_ledger").insert({
      id: randomUUID(),
      circle_id: circleId,
      member_id: member.id,
      delta: -amount,
      balance_after: row.balance,
      kind,
      note: String(note || "").slice(0, 200),
      ref_id: refId,
      actor_member_id: actorId,
    });
    return Number(row.balance);
  }

  async function checkAssignees(trx, circleId, assigneeIds, { exclude } = {}) {
    const unique = [...new Set(assigneeIds || [])];
    if (!unique.length) return [];
    const rows = await trx("rts_members").whereIn("id", unique).andWhere({ circle_id: circleId }).whereNull("removed_at");
    if (rows.length !== unique.length) fail(400, "unknown_member");
    if (rows.some((row) => !canEarn(row))) fail(400, "assignee_cannot_earn");
    if (exclude && unique.includes(exclude)) fail(400, "cannot_assign_yourself");
    return unique;
  }

  function checkGraph(graph) {
    const size = Buffer.byteLength(JSON.stringify(graph || {}));
    if (size > RTS_LIMITS.graphBytes) fail(413, "path_too_large");
    const result = engine.validateGraph(graph);
    if (!result.ok) fail(400, "invalid_path", { problems: result.errors.slice(0, 12) });
    return result.stats;
  }

  const requireKeeper = (member) => {
    if (!isKeeper(member)) fail(403, "keepers_only");
  };

  // ------------------------------------------------------------------ circles

  async function listMyCircles(userId) {
    const rows = await db("rts_members as m")
      .join("rts_circles as c", "c.id", "m.circle_id")
      .where("m.user_id", userId)
      .whereNull("m.removed_at")
      .whereNull("c.archived_at")
      .select(
        "c.id",
        "c.name",
        "c.kind",
        "c.sponsor_user_id",
        "c.seq",
        "m.id as member_id",
        "m.role",
        "m.display_name",
        "m.balance",
        "m.avatar",
        "m.color"
      )
      .orderBy("c.created_at", "asc");
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      seq: Number(row.seq),
      sponsoredByMe: row.sponsor_user_id === userId,
      sponsorUserId: row.sponsor_user_id,
      member: {
        id: row.member_id,
        role: row.role,
        displayName: row.display_name,
        balance: Number(row.balance),
        avatar: row.avatar,
        color: row.color,
      },
    }));
  }

  async function countMyCircles(trx, userId) {
    const [{ count }] = await trx("rts_members as m")
      .join("rts_circles as c", "c.id", "m.circle_id")
      .where("m.user_id", userId)
      .whereNull("m.removed_at")
      .whereNull("c.archived_at")
      .count({ count: "*" });
    return Number(count);
  }

  async function createCircle(user, input) {
    const circleId = randomUUID();
    return inTx(circleId, async (trx, emit) => {
      if ((await countMyCircles(trx, user.id)) >= RTS_LIMITS.circlesPerUser) fail(409, "too_many_circles");
      let inviteCode = makeInviteCode(randomInt);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const taken = await trx("rts_circles").where({ invite_code: inviteCode }).first();
        if (!taken) break;
        inviteCode = makeInviteCode(randomInt);
      }
      await trx("rts_circles").insert({
        id: circleId,
        name: input.name,
        kind: input.kind,
        invite_code: inviteCode,
        sponsor_user_id: user.id,
        created_by_user_id: user.id,
        timezone: input.timezone || "UTC",
      });
      const memberId = randomUUID();
      await trx("rts_members").insert({
        id: memberId,
        circle_id: circleId,
        user_id: user.id,
        display_name: input.displayName,
        role: input.role || defaultRole(input.kind, false),
        avatar: input.avatar || "gem",
        color: input.color || "cyan",
      });
      await emit("circle_created", memberId, { name: input.name });
      return { circleId, memberId, inviteCode };
    });
  }

  async function joinCircle(user, input) {
    const circle = await db("rts_circles").where({ invite_code: input.inviteCode }).whereNull("archived_at").first();
    if (!circle) fail(404, "invite_not_found");
    try {
      return await joinInside(circle, user, input);
    } catch (error) {
      // A double-tapped join: the other request already made the membership.
      if (error?.code !== "23505") throw error;
      const existing = await db("rts_members").where({ circle_id: circle.id, user_id: user.id }).whereNull("removed_at").first();
      if (!existing) throw error;
      return { circleId: circle.id, memberId: existing.id, alreadyMember: true };
    }
  }

  async function joinInside(circle, user, input) {
    return inTx(circle.id, async (trx, emit) => {
      const existing = await trx("rts_members")
        .where({ circle_id: circle.id, user_id: user.id })
        .whereNull("removed_at")
        .first();
      if (existing) return { circleId: circle.id, memberId: existing.id, alreadyMember: true };
      if ((await countMyCircles(trx, user.id)) >= RTS_LIMITS.circlesPerUser) fail(409, "too_many_circles");
      const [{ count }] = await trx("rts_members")
        .where({ circle_id: circle.id })
        .whereNull("removed_at")
        .count({ count: "*" });
      if (Number(count) >= RTS_LIMITS.membersPerCircle) fail(409, "circle_full");
      const memberId = randomUUID();
      await trx("rts_members").insert({
        id: memberId,
        circle_id: circle.id,
        user_id: user.id,
        display_name: input.displayName,
        role: defaultRole(circle.kind, true),
        avatar: input.avatar || "gem",
        color: input.color || "violet",
      });
      await emit("member_joined", memberId, { memberId, displayName: input.displayName });
      return { circleId: circle.id, memberId, alreadyMember: false };
    });
  }

  /** Who is asking, and for whom. Unknown circles and non-members both 404. */
  async function loadContext(user, circleId, actingMemberId) {
    const circle = await db("rts_circles").where({ id: circleId }).whereNull("archived_at").first();
    if (!circle) fail(404, "circle_not_found");
    const viewer = await db("rts_members")
      .where({ circle_id: circleId, user_id: user.id })
      .whereNull("removed_at")
      .first();
    if (!viewer) fail(404, "circle_not_found");
    let actor = viewer;
    if (actingMemberId && actingMemberId !== viewer.id) {
      if (!isKeeper(viewer)) fail(403, "keepers_only");
      actor = await db("rts_members").where({ id: actingMemberId, circle_id: circleId }).whereNull("removed_at").first();
      if (!actor || actor.user_id) fail(403, "not_a_managed_profile");
    }
    return { circle, viewer, actor, user };
  }

  async function circleState(ctx, { license } = {}) {
    const { circle, viewer, actor } = ctx;
    const [members, quests, paths, keys, runs, events] = await Promise.all([
      db("rts_members").where({ circle_id: circle.id }).whereNull("removed_at").orderBy("created_at"),
      db("rts_quests").where({ circle_id: circle.id }).whereNull("archived_at").orderBy("created_at", "desc"),
      db("rts_paths").where({ circle_id: circle.id }).orderBy("created_at", "desc"),
      db("rts_keys")
        .where({ circle_id: circle.id, member_id: actor.id })
        .whereNull("used_run_id")
        .select("path_id")
        .count({ count: "*" })
        .groupBy("path_id"),
      db("rts_runs")
        .where({ circle_id: circle.id })
        .andWhere((query) => {
          query.where("member_id", actor.id);
          if (isKeeper(viewer)) query.orWhere((inner) => inner.where("status", "complete").andWhereNot("member_id", viewer.id));
          if (isKeeper(viewer)) query.orWhere((inner) => inner.where("status", "active").andWhereNot("member_id", viewer.id));
        })
        .whereNot("status", "canceled")
        .orderBy("started_at", "desc")
        .limit(120),
      db("rts_events").where({ circle_id: circle.id }).orderBy("seq", "desc").limit(40),
    ]);

    const claimQuery = db("rts_claims as c")
      .join("rts_quests as q", "q.id", "c.quest_id")
      .where("c.circle_id", circle.id)
      .select("c.*", "q.title as quest_title", "q.icon as quest_icon")
      .orderBy("c.created_at", "desc")
      .limit(80);
    if (!isKeeper(viewer)) claimQuery.where("c.member_id", actor.id);
    else if (actor.id !== viewer.id) claimQuery.where("c.member_id", actor.id);
    const claims = await claimQuery;

    // Every path, archived ones included, answers "may this person see that
    // reward"; only live paths are listed.
    const pathById = new Map(paths.map((path) => [path.id, path]));
    const livePaths = paths.filter((path) => !path.archived_at);
    const keysByPath = new Map(keys.map((row) => [row.path_id, Number(row.count)]));
    const date = now();

    const actorClaims = claims.filter((claim) => claim.member_id === actor.id && claim.status !== "rejected");
    const questViews = quests.map((quest) => {
      const key = periodKey(quest.recurrence, circle.timezone, date);
      const live = actorClaims.find((claim) => claim.quest_id === quest.id && key !== "" && claim.period_key === key);
      const pending = actorClaims.filter((claim) => claim.quest_id === quest.id && claim.status === "pending").length;
      return {
        id: quest.id,
        title: quest.title,
        description: quest.description,
        icon: quest.icon,
        points: quest.points,
        keyPathId: quest.key_path_id,
        keyPathTitle: quest.key_path_id ? livePaths.find((path) => path.id === quest.key_path_id)?.title || null : null,
        recurrence: quest.recurrence,
        assigneeIds: idList(quest.assignee_ids),
        requiresApproval: quest.requires_approval,
        createdBy: quest.created_by_member,
        eligible: eligibleForQuest(actor, quest),
        state: live ? live.status : "available",
        pendingCount: pending,
      };
    });

    const myRuns = runs.filter((run) => run.member_id === actor.id);
    const pathViews = livePaths.map((path) => {
      const secrets = isKeeper(viewer) && canSeePathSecrets(viewer, path);
      const mine = myRuns.filter((run) => run.path_id === path.id);
      const active = mine.find((run) => run.status === "active");
      const graph = json(path.graph);
      return {
        id: path.id,
        title: path.title,
        teaser: path.teaser,
        icon: path.icon,
        color: path.color,
        cost: path.cost === null ? null : Number(path.cost),
        repeatable: path.repeatable,
        assigneeIds: idList(path.assignee_ids),
        createdBy: path.created_by_member,
        eligible: eligibleForPath(actor, path),
        canEdit: secrets,
        stats: secrets ? engine.validateGraph(graph).stats : null,
        keys: keysByPath.get(path.id) || 0,
        opened: mine.length,
        activeRunId: active ? active.id : null,
      };
    });

    const claimViews = claims.map((claim) => ({
      id: claim.id,
      questId: claim.quest_id,
      questTitle: claim.quest_title,
      questIcon: claim.quest_icon,
      memberId: claim.member_id,
      status: claim.status,
      note: claim.note,
      points: claim.points,
      createdAt: iso(claim.created_at),
      decidedAt: iso(claim.decided_at),
      decidedNote: claim.decided_note,
      canDecide: claim.status === "pending" && isKeeper(viewer) && claim.member_id !== viewer.id,
    }));

    const runViews = runs.map((run) => runView(run, { viewer, actor, path: pathById.get(run.path_id) }));

    const eventViews = events.map((event) => {
      const data = { ...(json(event.data) || {}) };
      if ("rewardTitle" in data && !rewardVisible(data.memberId, viewer, actor, pathById.get(data.pathId))) {
        delete data.rewardTitle;
      }
      return { seq: Number(event.seq), type: event.type, actorMemberId: event.actor_member_id, data, at: iso(event.created_at) };
    });

    return {
      circle: {
        id: circle.id,
        name: circle.name,
        kind: circle.kind,
        timezone: circle.timezone,
        seq: Number(circle.seq),
        inviteCode: isKeeper(viewer) ? circle.invite_code : null,
        sponsoredByViewer: Boolean(circle.sponsor_user_id) && circle.sponsor_user_id === viewer.user_id,
        licenseActive: license ? Boolean(license.active) : true,
      },
      viewerId: viewer.id,
      actorId: actor.id,
      members: members.map((member) => memberView(member, viewer)),
      quests: questViews,
      paths: pathViews,
      claims: claimViews,
      runs: runViews,
      events: eventViews,
    };
  }

  async function updateCircle(ctx, input) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      const patch = {};
      if (input.name) patch.name = input.name;
      if (input.timezone) patch.timezone = input.timezone;
      if (!Object.keys(patch).length) return { ok: true };
      await trx("rts_circles").where({ id: ctx.circle.id }).update({ ...patch, updated_at: trx.fn.now() });
      await emit("circle_updated", ctx.viewer.id, { name: patch.name || ctx.circle.name });
      return { ok: true };
    });
  }

  async function rotateInvite(ctx) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      let code = makeInviteCode(randomInt);
      for (let attempt = 0; attempt < 5 && (await trx("rts_circles").where({ invite_code: code }).first()); attempt += 1) {
        code = makeInviteCode(randomInt);
      }
      await trx("rts_circles").where({ id: ctx.circle.id }).update({ invite_code: code, updated_at: trx.fn.now() });
      await emit("invite_rotated", ctx.viewer.id, {});
      return { inviteCode: code };
    });
  }

  async function sponsorCircle(ctx) {
    requireKeeper(ctx.viewer);
    if (!ctx.viewer.user_id) fail(403, "keepers_only");
    return inTx(ctx.circle.id, async (trx, emit) => {
      await trx("rts_circles")
        .where({ id: ctx.circle.id })
        .update({ sponsor_user_id: ctx.viewer.user_id, updated_at: trx.fn.now() });
      await emit("sponsor_changed", ctx.viewer.id, { displayName: ctx.viewer.display_name });
      return { ok: true };
    });
  }

  async function keepersAfter(trx, circleId, change) {
    const members = await trx("rts_members").where({ circle_id: circleId }).whereNull("removed_at");
    return members
      .map((member) => (member.id === change.id ? { ...member, ...change } : member))
      .filter((member) => !member.removed && member.user_id && isKeeper(member));
  }

  /** Close a departing member's open business: pending claims and walks. */
  async function retireMember(trx, circle, member, note) {
    await trx("rts_claims")
      .where({ member_id: member.id, status: "pending" })
      .update({ status: "rejected", decided_note: note, decided_at: trx.fn.now() });
    await trx("rts_runs").where({ member_id: member.id, status: "active" }).update({ status: "canceled", updated_at: trx.fn.now() });
    await trx("rts_members").where({ id: member.id }).update({ removed_at: trx.fn.now(), updated_at: trx.fn.now() });
    if (member.user_id && circle.sponsor_user_id === member.user_id) {
      await trx("rts_circles").where({ id: circle.id }).update({ sponsor_user_id: null, updated_at: trx.fn.now() });
      return true;
    }
    return false;
  }

  async function leaveCircle(ctx) {
    const { circle, viewer } = ctx;
    return inTx(circle.id, async (trx, emit) => {
      const accountMembers = await trx("rts_members")
        .where({ circle_id: circle.id })
        .whereNull("removed_at")
        .whereNotNull("user_id");
      const others = accountMembers.filter((member) => member.id !== viewer.id);
      if (isKeeper(viewer) && others.length && !others.some(isKeeper)) fail(409, "promote_a_keeper_first");
      const current = await trx("rts_circles").where({ id: circle.id }).first();
      const tookLicence = await retireMember(trx, current, viewer, "Left the circle");
      if (!others.length) {
        await trx("rts_circles").where({ id: circle.id }).update({ archived_at: trx.fn.now() });
        return { archived: true };
      }
      await emit("member_left", viewer.id, { memberId: viewer.id, displayName: viewer.display_name });
      if (tookLicence) await emit("sponsor_left", viewer.id, { displayName: viewer.display_name });
      return { archived: false };
    });
  }

  async function addMember(ctx, input) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      const [{ count }] = await trx("rts_members")
        .where({ circle_id: ctx.circle.id })
        .whereNull("removed_at")
        .count({ count: "*" });
      if (Number(count) >= RTS_LIMITS.membersPerCircle) fail(409, "circle_full");
      const id = randomUUID();
      await trx("rts_members").insert({
        id,
        circle_id: ctx.circle.id,
        user_id: null,
        display_name: input.displayName,
        role: "seeker",
        avatar: input.avatar || "star",
        color: input.color || "pink",
      });
      await emit("member_added", ctx.viewer.id, { memberId: id, displayName: input.displayName });
      return { memberId: id };
    });
  }

  async function updateMember(ctx, memberId, input) {
    const { circle, viewer } = ctx;
    return inTx(circle.id, async (trx, emit) => {
      const target = await activeMember(trx, circle.id, memberId);
      const self = target.id === viewer.id;
      if (!self) requireKeeper(viewer);
      const patch = {};
      if (input.displayName) patch.display_name = input.displayName;
      if (input.avatar) patch.avatar = input.avatar;
      if (input.color) patch.color = input.color;
      if (input.role && input.role !== target.role) {
        if (!target.user_id) fail(400, "managed_profiles_are_seekers");
        if (!isKeeper(viewer)) fail(403, "keepers_only");
        // A role decides who may see behind whose doors, so it is always set
        // by someone else.
        if (self) fail(403, "ask_another_keeper");
        const remaining = await keepersAfter(trx, circle.id, { id: target.id, role: input.role });
        if (!remaining.length) fail(409, "a_circle_needs_a_keeper");
        patch.role = input.role;
      }
      if (!Object.keys(patch).length) return { ok: true };
      await trx("rts_members").where({ id: target.id }).update({ ...patch, updated_at: trx.fn.now() });
      await emit("member_updated", viewer.id, { memberId: target.id });
      return { ok: true };
    });
  }

  async function removeMember(ctx, memberId) {
    requireKeeper(ctx.viewer);
    if (memberId === ctx.viewer.id) fail(400, "use_leave");
    return inTx(ctx.circle.id, async (trx, emit) => {
      const target = await activeMember(trx, ctx.circle.id, memberId);
      if (target.user_id && isKeeper(target)) {
        const remaining = await keepersAfter(trx, ctx.circle.id, { id: target.id, role: "seeker" });
        if (!remaining.length) fail(409, "a_circle_needs_a_keeper");
      }
      const current = await trx("rts_circles").where({ id: ctx.circle.id }).first();
      const tookLicence = await retireMember(trx, current, target, "Removed from the circle");
      await emit("member_removed", ctx.viewer.id, { memberId: target.id, displayName: target.display_name });
      if (tookLicence) await emit("sponsor_left", ctx.viewer.id, { displayName: target.display_name });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------- quests

  async function checkKeyPath(trx, circleId, pathId) {
    if (!pathId) return null;
    const path = await trx("rts_paths").where({ id: pathId, circle_id: circleId }).whereNull("archived_at").first();
    if (!path) fail(400, "unknown_path");
    return path.id;
  }

  async function createQuest(ctx, input) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      const [{ count }] = await trx("rts_quests")
        .where({ circle_id: ctx.circle.id })
        .whereNull("archived_at")
        .count({ count: "*" });
      if (Number(count) >= RTS_LIMITS.questsPerCircle) fail(409, "too_many_quests");
      const id = randomUUID();
      await trx("rts_quests").insert({
        id,
        circle_id: ctx.circle.id,
        title: input.title,
        description: input.description || "",
        icon: input.icon || "star",
        points: input.points,
        key_path_id: await checkKeyPath(trx, ctx.circle.id, input.keyPathId),
        recurrence: input.recurrence,
        assignee_ids: JSON.stringify(await checkAssignees(trx, ctx.circle.id, input.assigneeIds, { exclude: ctx.viewer.id })),
        requires_approval: input.requiresApproval,
        created_by_member: ctx.viewer.id,
      });
      await emit("quest_created", ctx.viewer.id, { questId: id, title: input.title });
      return { questId: id };
    });
  }

  async function updateQuest(ctx, questId, input) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      const quest = await trx("rts_quests").where({ id: questId, circle_id: ctx.circle.id }).whereNull("archived_at").first();
      if (!quest) fail(404, "quest_not_found");
      const patch = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.icon !== undefined) patch.icon = input.icon;
      if (input.points !== undefined) patch.points = input.points;
      if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
      if (input.requiresApproval !== undefined) patch.requires_approval = input.requiresApproval;
      if (input.keyPathId !== undefined) patch.key_path_id = await checkKeyPath(trx, ctx.circle.id, input.keyPathId);
      if (input.assigneeIds !== undefined) {
        patch.assignee_ids = JSON.stringify(await checkAssignees(trx, ctx.circle.id, input.assigneeIds, { exclude: ctx.viewer.id }));
      }
      await trx("rts_quests").where({ id: quest.id }).update({ ...patch, updated_at: trx.fn.now() });
      await emit("quest_updated", ctx.viewer.id, { questId: quest.id, title: patch.title || quest.title });
      return { ok: true };
    });
  }

  async function archiveQuest(ctx, questId) {
    requireKeeper(ctx.viewer);
    return inTx(ctx.circle.id, async (trx, emit) => {
      const count = await trx("rts_quests")
        .where({ id: questId, circle_id: ctx.circle.id })
        .whereNull("archived_at")
        .update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
      if (!count) fail(404, "quest_not_found");
      // Claims still waiting on a removed quest are closed without stones.
      await trx("rts_claims")
        .where({ quest_id: questId, status: "pending" })
        .update({ status: "rejected", decided_note: "Quest removed", decided_at: trx.fn.now() });
      await emit("quest_archived", ctx.viewer.id, { questId });
      return { ok: true };
    });
  }

  async function approveInside(trx, emit, { circle, claim, quest, member, deciderId, note }) {
    // Pay what the quest was worth when it was claimed, which is what the
    // approver saw.
    const points = Number(claim.points);
    await trx("rts_claims")
      .where({ id: claim.id })
      .update({
        status: "approved",
        decided_by_member: deciderId,
        decided_note: note || "",
        decided_at: trx.fn.now(),
      });
    if (points > 0) {
      await credit(trx, {
        circleId: circle.id,
        member,
        amount: points,
        kind: "quest",
        note: quest.title,
        refId: claim.id,
        actorId: deciderId,
      });
    }
    let keyPathTitle = null;
    if (quest.key_path_id) {
      const path = await trx("rts_paths").where({ id: quest.key_path_id }).whereNull("archived_at").first();
      if (path) {
        await trx("rts_keys").insert({
          id: randomUUID(),
          circle_id: circle.id,
          member_id: member.id,
          path_id: path.id,
          source: "quest",
          source_ref: claim.id,
        });
        keyPathTitle = path.title;
      }
    }
    await emit("claim_approved", deciderId, {
      claimId: claim.id,
      questId: quest.id,
      questTitle: quest.title,
      memberId: member.id,
      points,
      keyPathTitle,
    });
  }

  async function claimQuest(ctx, questId, input) {
    const { circle, actor } = ctx;
    return inTx(circle.id, async (trx, emit) => {
      const quest = await trx("rts_quests").where({ id: questId, circle_id: circle.id }).whereNull("archived_at").first();
      if (!quest) fail(404, "quest_not_found");
      if (!eligibleForQuest(actor, quest)) fail(403, "not_your_quest");
      const key = periodKey(quest.recurrence, circle.timezone, now());
      if (key) {
        const live = await trx("rts_claims")
          .where({ quest_id: quest.id, member_id: actor.id, period_key: key })
          .whereIn("status", ["pending", "approved"])
          .first();
        if (live) fail(409, "already_claimed", { state: live.status });
      }
      const claim = {
        id: randomUUID(),
        circle_id: circle.id,
        quest_id: quest.id,
        member_id: actor.id,
        status: "pending",
        note: input.note || "",
        period_key: key,
        points: quest.points,
      };
      try {
        await trx("rts_claims").insert(claim);
      } catch (error) {
        if (error?.code === "23505") fail(409, "already_claimed", { state: "pending" });
        throw error;
      }
      // Keepers' own claims always wait for another keeper, so nobody who can
      // set up a quest can pay themselves with it.
      if (!quest.requires_approval && !isKeeper(actor)) {
        await approveInside(trx, emit, { circle, claim, quest, member: actor, deciderId: null, note: "" });
        return { claimId: claim.id, status: "approved" };
      }
      await emit("claim_submitted", actor.id, {
        claimId: claim.id,
        questId: quest.id,
        questTitle: quest.title,
        memberId: actor.id,
      });
      return { claimId: claim.id, status: "pending" };
    });
  }

  async function decideClaim(ctx, claimId, input) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    return inTx(circle.id, async (trx, emit) => {
      const claim = await trx("rts_claims").where({ id: claimId, circle_id: circle.id }).forUpdate().first();
      if (!claim) fail(404, "claim_not_found");
      if (claim.status !== "pending") fail(409, "already_decided", { status: claim.status });
      if (claim.member_id === viewer.id) fail(403, "cannot_decide_own_claim");
      const quest = await trx("rts_quests").where({ id: claim.quest_id }).first();
      const member = await trx("rts_members").where({ id: claim.member_id }).first();
      if (input.approve) {
        if (!member || member.removed_at) fail(409, "member_not_found");
        await approveInside(trx, emit, { circle, claim, quest, member, deciderId: viewer.id, note: input.note });
        return { status: "approved" };
      }
      await trx("rts_claims").where({ id: claim.id }).update({
        status: "rejected",
        decided_by_member: viewer.id,
        decided_note: input.note || "",
        decided_at: trx.fn.now(),
      });
      await emit("claim_rejected", viewer.id, {
        claimId: claim.id,
        questId: quest.id,
        questTitle: quest.title,
        memberId: member.id,
      });
      return { status: "rejected" };
    });
  }

  async function gift(ctx, input) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    return inTx(circle.id, async (trx, emit) => {
      const member = await activeMember(trx, circle.id, input.memberId);
      if (member.id === viewer.id) fail(403, "cannot_gift_yourself");
      if (!canEarn(member)) fail(400, "member_cannot_earn");
      let balance = Number(member.balance);
      if (input.stones > 0) {
        balance = await credit(trx, {
          circleId: circle.id,
          member,
          amount: input.stones,
          kind: "gift",
          note: input.note,
          actorId: viewer.id,
        });
      } else if (input.stones < 0) {
        balance = await debit(trx, {
          circleId: circle.id,
          member,
          amount: -input.stones,
          kind: "adjust",
          note: input.note,
          actorId: viewer.id,
        });
      }
      let pathTitle = null;
      if (input.pathId) {
        const path = await trx("rts_paths").where({ id: input.pathId, circle_id: circle.id }).whereNull("archived_at").first();
        if (!path) fail(400, "unknown_path");
        if (!eligibleForPath(member, path)) fail(400, "path_not_for_member");
        await trx("rts_keys").insert({
          id: randomUUID(),
          circle_id: circle.id,
          member_id: member.id,
          path_id: path.id,
          source: "gift",
        });
        pathTitle = path.title;
      }
      await emit("gift", viewer.id, { memberId: member.id, stones: input.stones, pathTitle, note: input.note });
      return { balance };
    });
  }

  async function ledger(ctx, memberId) {
    const { circle, viewer, actor } = ctx;
    const target = memberId || actor.id;
    if (target !== actor.id && target !== viewer.id && !isKeeper(viewer)) fail(403, "keepers_only");
    const rows = await db("rts_ledger").where({ circle_id: circle.id, member_id: target }).orderBy("created_at", "desc").limit(100);
    return rows.map((row) => ({
      id: row.id,
      delta: row.delta,
      balanceAfter: row.balance_after,
      kind: row.kind,
      note: row.note,
      at: iso(row.created_at),
    }));
  }

  // -------------------------------------------------------------------- paths

  /** Remember that this member has seen behind the path's doors. */
  async function markSeen(database, path, member) {
    if (idList(path.seen_by).includes(member.id)) return;
    await database("rts_paths")
      .where({ id: path.id })
      .update({
        seen_by: database.raw(
          "(select coalesce(jsonb_agg(distinct value), '[]'::jsonb) from jsonb_array_elements(coalesce(seen_by, '[]'::jsonb) || ?::jsonb))",
          [JSON.stringify([member.id])]
        ),
      });
  }

  async function createPath(ctx, input) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    const stats = checkGraph(input.graph);
    return inTx(circle.id, async (trx, emit) => {
      const [{ count }] = await trx("rts_paths").where({ circle_id: circle.id }).whereNull("archived_at").count({ count: "*" });
      if (Number(count) >= RTS_LIMITS.pathsPerCircle) fail(409, "too_many_paths");
      const assignees = await checkAssignees(trx, circle.id, input.assigneeIds, { exclude: viewer.id });
      const id = randomUUID();
      await trx("rts_paths").insert({
        id,
        circle_id: circle.id,
        title: input.title,
        teaser: input.teaser || "",
        icon: input.icon,
        color: input.color,
        cost: input.cost,
        repeatable: input.repeatable,
        assignee_ids: JSON.stringify(assignees),
        graph: JSON.stringify(input.graph),
        seen_by: JSON.stringify([viewer.id]),
        created_by_member: viewer.id,
      });
      await emit("path_created", viewer.id, { pathId: id, title: input.title });
      return { pathId: id, stats };
    });
  }

  async function getPath(ctx, pathId) {
    const { circle, viewer, actor } = ctx;
    const path = await db("rts_paths").where({ id: pathId, circle_id: circle.id }).whereNull("archived_at").first();
    if (!path) fail(404, "path_not_found");
    const view = {
      id: path.id,
      title: path.title,
      teaser: path.teaser,
      icon: path.icon,
      color: path.color,
      cost: path.cost === null ? null : Number(path.cost),
      repeatable: path.repeatable,
      assigneeIds: idList(path.assignee_ids),
      createdBy: path.created_by_member,
      eligible: eligibleForPath(actor, path),
      canEdit: canSeePathSecrets(viewer, path),
    };
    if (!view.canEdit) return view;
    await markSeen(db, path, viewer);
    const graph = json(path.graph);
    return { ...view, graph, stats: engine.validateGraph(graph).stats };
  }

  async function updatePath(ctx, pathId, input) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    if (input.graph !== undefined) checkGraph(input.graph);
    return inTx(circle.id, async (trx, emit) => {
      const path = await trx("rts_paths").where({ id: pathId, circle_id: circle.id }).whereNull("archived_at").first();
      if (!path) fail(404, "path_not_found");
      if (!canSeePathSecrets(viewer, path)) fail(403, "not_your_path_to_edit");
      await markSeen(trx, path, viewer);
      const patch = {};
      for (const [field, column] of [
        ["title", "title"],
        ["teaser", "teaser"],
        ["icon", "icon"],
        ["color", "color"],
        ["cost", "cost"],
        ["repeatable", "repeatable"],
      ]) {
        if (input[field] !== undefined) patch[column] = input[field];
      }
      if (input.assigneeIds !== undefined) {
        patch.assignee_ids = JSON.stringify(await checkAssignees(trx, circle.id, input.assigneeIds, { exclude: viewer.id }));
      }
      if (input.graph !== undefined) patch.graph = JSON.stringify(input.graph);
      await trx("rts_paths").where({ id: path.id }).update({ ...patch, updated_at: trx.fn.now() });
      // Walks already underway keep the snapshot they started with.
      await emit("path_updated", viewer.id, { pathId: path.id, title: patch.title || path.title });
      return { ok: true };
    });
  }

  async function archivePath(ctx, pathId) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    return inTx(circle.id, async (trx, emit) => {
      const path = await trx("rts_paths").where({ id: pathId, circle_id: circle.id }).whereNull("archived_at").first();
      if (!path) fail(404, "path_not_found");
      if (!canSeePathSecrets(viewer, path)) fail(403, "not_your_path_to_edit");
      await trx("rts_paths").where({ id: path.id }).update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
      await emit("path_archived", viewer.id, { pathId: path.id, title: path.title });
      return { ok: true };
    });
  }

  // --------------------------------------------------------------------- runs

  async function openPath(ctx, pathId, input) {
    const { circle, viewer, actor } = ctx;
    return inTx(circle.id, async (trx, emit) => {
      const path = await trx("rts_paths").where({ id: pathId, circle_id: circle.id }).whereNull("archived_at").first();
      if (!path) fail(404, "path_not_found");
      if (!eligibleForPath(actor, path)) fail(403, "not_your_path");

      const active = await trx("rts_runs").where({ member_id: actor.id, path_id: path.id, status: "active" }).first();
      if (active) return { run: runView(active, { viewer, actor, path }), resumed: true };
      if (!path.repeatable) {
        const done = await trx("rts_runs").where({ member_id: actor.id, path_id: path.id, status: "complete" }).first();
        if (done) fail(409, "already_opened");
      }

      const graph = json(path.graph);
      const runId = randomUUID();
      let keyId = null;
      let costPaid = 0;
      if (input.payWith === "key") {
        const key = await trx("rts_keys")
          .where({ member_id: actor.id, path_id: path.id })
          .whereNull("used_run_id")
          .orderBy("created_at")
          .forUpdate()
          .skipLocked()
          .first();
        if (!key) fail(409, "no_key");
        keyId = key.id;
      } else if (input.payWith === "stones") {
        if (path.cost === null) fail(409, "key_only");
        costPaid = Number(path.cost);
        if (costPaid > 0) {
          await debit(trx, {
            circleId: circle.id,
            member: actor,
            amount: costPaid,
            kind: "spend",
            note: path.title,
            refId: runId,
            actorId: actor.id,
          });
        }
      } else if (Number(path.cost) !== 0 || path.cost === null) {
        fail(409, "not_free");
      }

      const run = {
        id: runId,
        circle_id: circle.id,
        path_id: path.id,
        member_id: actor.id,
        path_title: path.title,
        path_icon: path.icon,
        path_color: path.color,
        graph: JSON.stringify(graph),
        current_node: graph.start,
        status: "active",
        paid_with: input.payWith,
        cost_paid: costPaid,
        key_id: keyId,
        steps: JSON.stringify([]),
      };
      try {
        await trx("rts_runs").insert(run);
      } catch (error) {
        if (error?.code === "23505") fail(409, "already_open");
        throw error;
      }
      if (keyId) await trx("rts_keys").where({ id: keyId }).update({ used_run_id: runId, used_at: trx.fn.now() });
      await emit("run_started", actor.id, { runId, pathId: path.id, pathTitle: path.title, memberId: actor.id });
      const stored = await trx("rts_runs").where({ id: runId }).first();
      return { run: runView(stored, { viewer, actor, path }), resumed: false };
    });
  }

  async function getRun(ctx, runId) {
    const { circle, viewer, actor } = ctx;
    const run = await db("rts_runs").where({ id: runId, circle_id: circle.id }).first();
    if (!run) fail(404, "journey_not_found");
    if (run.member_id !== actor.id && !isKeeper(viewer)) fail(404, "journey_not_found");
    const path = await db("rts_paths").where({ id: run.path_id }).first();
    return runView(run, { viewer, actor, path });
  }

  async function step(ctx, runId, input) {
    const { circle, viewer, actor } = ctx;
    return inTx(circle.id, async (trx, emit) => {
      const run = await trx("rts_runs").where({ id: runId, circle_id: circle.id }).forUpdate().first();
      if (!run) fail(404, "journey_not_found");
      if (run.member_id !== actor.id) fail(403, "not_your_journey");
      const steps = json(run.steps) || [];
      if (run.status !== "active" || run.current_node !== input.nodeId) {
        // A retried request for a step already taken gets the same answer.
        const prior = steps.find(
          (entry) => entry.nodeId === input.nodeId && (entry.type === "chance" || entry.optionId === input.optionId)
        );
        if (prior) {
          const path = await trx("rts_paths").where({ id: run.path_id }).first();
          return { record: prior, run: runView(run, { viewer, actor, path }), replayed: true };
        }
        fail(409, run.status === "active" ? "stale_step" : "journey_finished");
      }
      const graph = json(run.graph);
      let result;
      try {
        result = engine.takeStep(graph, input.nodeId, input.optionId, randomInt);
      } catch (error) {
        if (error instanceof engine.PathStepError) fail(400, error.code);
        throw error;
      }
      const record = { ...result.record, at: now().toISOString() };
      const patch = {
        current_node: result.nextId,
        steps: JSON.stringify([...steps, record]),
        updated_at: trx.fn.now(),
      };
      let reward = null;
      if (result.finished) {
        reward = engine.rewardSnapshot(graph, result.nextId);
        Object.assign(patch, {
          status: "complete",
          reward: JSON.stringify(reward),
          fulfillment: "waiting",
          completed_at: trx.fn.now(),
        });
      }
      await trx("rts_runs").where({ id: run.id }).update(patch);
      if (result.finished) {
        await emit("run_completed", actor.id, {
          runId: run.id,
          pathId: run.path_id,
          pathTitle: run.path_title,
          memberId: actor.id,
          rewardTitle: reward.title,
        });
      }
      const stored = await trx("rts_runs").where({ id: run.id }).first();
      const path = await trx("rts_paths").where({ id: run.path_id }).first();
      return { record, run: runView(stored, { viewer, actor, path }), replayed: false };
    });
  }

  async function fulfill(ctx, runId, input) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    return inTx(circle.id, async (trx, emit) => {
      const run = await trx("rts_runs").where({ id: runId, circle_id: circle.id }).forUpdate().first();
      if (!run) fail(404, "journey_not_found");
      if (run.status !== "complete") fail(409, "journey_not_finished");
      if (run.member_id === viewer.id) fail(403, "cannot_fulfill_own_reward");
      await trx("rts_runs").where({ id: run.id }).update({
        fulfillment: input.status,
        fulfillment_note: input.note || "",
        fulfilled_by_member: viewer.id,
        fulfilled_at: input.status === "delivered" ? trx.fn.now() : null,
        updated_at: trx.fn.now(),
      });
      const reward = json(run.reward) || {};
      await emit("treasure_updated", viewer.id, {
        runId: run.id,
        pathId: run.path_id,
        memberId: run.member_id,
        status: input.status,
        rewardTitle: reward.title || "",
      });
      return { ok: true };
    });
  }

  async function cancelRun(ctx, runId) {
    const { circle, viewer } = ctx;
    requireKeeper(viewer);
    return inTx(circle.id, async (trx, emit) => {
      const run = await trx("rts_runs").where({ id: runId, circle_id: circle.id }).forUpdate().first();
      if (!run) fail(404, "journey_not_found");
      if (run.status !== "active") fail(409, "journey_not_active");
      if (run.member_id === viewer.id) fail(403, "cannot_cancel_own_journey");
      await trx("rts_runs").where({ id: run.id }).update({ status: "canceled", updated_at: trx.fn.now() });
      const member = await trx("rts_members").where({ id: run.member_id }).first();
      if (run.paid_with === "stones" && run.cost_paid > 0 && member && !member.removed_at) {
        await credit(trx, {
          circleId: circle.id,
          member,
          amount: Number(run.cost_paid),
          kind: "refund",
          note: run.path_title,
          refId: run.id,
          actorId: viewer.id,
        });
      }
      if (run.key_id) await trx("rts_keys").where({ id: run.key_id }).update({ used_run_id: null, used_at: null });
      await emit("run_canceled", viewer.id, { runId: run.id, pathTitle: run.path_title, memberId: run.member_id });
      return { ok: true };
    });
  }

  return {
    listMyCircles,
    createCircle,
    joinCircle,
    loadContext,
    circleState,
    updateCircle,
    rotateInvite,
    sponsorCircle,
    leaveCircle,
    addMember,
    updateMember,
    removeMember,
    createQuest,
    updateQuest,
    archiveQuest,
    claimQuest,
    decideClaim,
    gift,
    ledger,
    createPath,
    getPath,
    updatePath,
    archivePath,
    openPath,
    getRun,
    step,
    fulfill,
    cancelRun,
  };
}
