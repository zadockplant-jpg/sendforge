import express from "express";
import { ZodError } from "zod";
import { createRateLimiter } from "../../middleware/rateLimit.js";
import { RTS_VERSION } from "./config.js";
import { perkById, perksFor, PERK_STATUS } from "./perks.js";
import {
  cleanDeviceLabel,
  DEVICE_ID,
  DeviceLimitReached,
  ensureDevice,
  listDevices,
  PRICING,
  resolveLicense,
  revokeDevice,
} from "./license.js";
import { RtsError } from "./service.js";
import * as schemas from "./validation.js";

const byUser = (req) => req.user?.sub || req.ip || "unknown";

/** Writes a paused circle still allows: leaving, and a keeper taking over the licence. */
const PAUSED_ALLOWED = [/\/leave$/, /\/sponsor$/];

export function createRtsRouter({ getConfig, requireAuth, db, service, hub, licenseCache, logger = console }) {
  const router = express.Router();
  const deviceSeen = new Map();
  const DEVICE_SEEN_MS = 5 * 60 * 1000;
  const openStreams = new Map();
  const STREAMS_PER_ACCOUNT = 8;
  const NO_LICENCE = Object.freeze({ active: false, plan: null, subscription: null, deviceLimit: 10 });

  const parse = (schema, body) => schema.parse(body ?? {});

  async function licenseFor(userId) {
    if (!userId) return NO_LICENCE;
    return licenseCache.get(userId, async () => {
      const user = await db("users").select("id", "email").where({ id: userId }).first();
      return resolveLicense(db, { userId, email: user?.email }, getConfig());
    });
  }

  async function holdDevice(req, sponsorUserId) {
    const deviceId = String(req.get("X-RTS-Device") || "");
    if (!DEVICE_ID.test(deviceId)) throw new RtsError(400, "device_required");
    const key = `${sponsorUserId}:${deviceId}`;
    const seen = deviceSeen.get(key);
    if (seen && seen > Date.now()) return;
    await ensureDevice(db, {
      sponsorUserId,
      deviceId,
      userId: req.user.sub,
      label: cleanDeviceLabel(req.get("X-RTS-Device-Label")),
    });
    if (deviceSeen.size > 20_000) deviceSeen.clear();
    deviceSeen.set(key, Date.now() + DEVICE_SEEN_MS);
  }

  const forgetSponsorDevices = (sponsorUserId) => {
    for (const key of deviceSeen.keys()) if (key.startsWith(`${sponsorUserId}:`)) deviceSeen.delete(key);
  };

  const wrap = (handler) => async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  router.get("/health", (_req, res) => {
    const config = getConfig();
    res.status(config.enabled ? 200 : 503).json({ ok: config.enabled, service: "romancing-the-stone", version: RTS_VERSION });
  });

  router.use((req, res, next) => {
    if (!getConfig().enabled) return res.status(503).json({ error: "service_unavailable" });
    return next();
  });

  router.use(express.json({ limit: getConfig().bodyLimit, strict: true }));
  router.use(requireAuth);

  const writeLimiter = createRateLimiter({
    name: "rts-writes",
    windowMs: 60 * 1000,
    max: 240,
    keyGenerator: byUser,
    message: "slow_down",
  });
  const joinLimiter = createRateLimiter({
    name: "rts-join",
    windowMs: 10 * 60 * 1000,
    max: 10,
    keyGenerator: byUser,
    message: "too_many_join_attempts",
  });
  router.use((req, res, next) => (req.method === "GET" ? next() : writeLimiter(req, res, next)));

  const user = (req) => ({ id: req.user.sub, email: req.user.email });

  // ------------------------------------------------------------ account level

  router.get(
    "/me",
    wrap(async (req, res) => {
      const license = await licenseFor(req.user.sub);
      const [circles, devices] = await Promise.all([
        service.listMyCircles(req.user.sub),
        license.active ? listDevices(db, req.user.sub) : [],
      ]);
      res.json({
        user: user(req),
        license: { ...license, devicesUsed: devices.length },
        pricing: PRICING,
        perks: perksFor(license),
        circles,
      });
    })
  );

  router.get(
    "/devices",
    wrap(async (req, res) => {
      res.json({ devices: await listDevices(db, req.user.sub), limit: PRICING.deviceLimit });
    })
  );

  router.delete(
    "/devices/:deviceRowId",
    wrap(async (req, res) => {
      const count = await revokeDevice(db, { sponsorUserId: req.user.sub, id: req.params.deviceRowId });
      if (!count) throw new RtsError(404, "device_not_found");
      forgetSponsorDevices(req.user.sub);
      res.json({ ok: true });
    })
  );

  router.get(
    "/perks",
    wrap(async (req, res) => {
      res.json({ perks: perksFor(await licenseFor(req.user.sub)) });
    })
  );

  router.post(
    "/perks/:perkId/claim",
    wrap(async (req, res) => {
      const perk = perkById(req.params.perkId);
      if (!perk) throw new RtsError(404, "perk_not_found");
      const view = perksFor(await licenseFor(req.user.sub)).find((item) => item.id === perk.id);
      if (!view.eligible) throw new RtsError(403, "perk_not_included");
      // Every perk is still being arranged. When one goes live its fulfilment
      // lands here and rts_perk_claims records the choice.
      if (perk.status !== PERK_STATUS.AVAILABLE) throw new RtsError(409, "perk_coming_soon");
      throw new RtsError(501, "perk_fulfilment_not_built");
    })
  );

  router.post(
    "/circles",
    wrap(async (req, res) => {
      const input = parse(schemas.createCircleSchema, req.body);
      const license = await licenseFor(req.user.sub);
      if (!license.active) throw new RtsError(402, "license_required");
      const created = await service.createCircle(user(req), input);
      res.status(201).json(created);
    })
  );

  router.post(
    "/circles/join",
    joinLimiter,
    wrap(async (req, res) => {
      const input = parse(schemas.joinCircleSchema, req.body);
      const joined = await service.joinCircle(user(req), input);
      res.status(joined.alreadyMember ? 200 : 201).json(joined);
    })
  );

  // -------------------------------------------------------------- per circle

  const circle = express.Router({ mergeParams: true });
  router.use("/circles/:circleId", (req, res, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.circleId)) return res.status(404).json({ error: "circle_not_found" });
    return next();
  }, circle);

  circle.use(
    wrap(async (req, _res, next) => {
      const ctx = await service.loadContext(user(req), req.params.circleId, req.get("X-RTS-Member") || null);
      // A circle whose sponsor left has no licence until a keeper takes it over.
      const license = await licenseFor(ctx.circle.sponsor_user_id);
      if (license.active) {
        try {
          await holdDevice(req, ctx.circle.sponsor_user_id);
        } catch (error) {
          if (error instanceof DeviceLimitReached) {
            throw new RtsError(403, "device_limit_reached", {
              limit: error.limit,
              used: error.used,
              sponsoredByYou: ctx.circle.sponsor_user_id === req.user.sub,
            });
          }
          throw error;
        }
      } else if (req.method !== "GET" && !PAUSED_ALLOWED.some((pattern) => pattern.test(req.path))) {
        throw new RtsError(402, "circle_paused", { sponsoredByYou: ctx.circle.sponsor_user_id === req.user.sub });
      }
      req.rts = { ctx, license };
      next();
    })
  );

  circle.get(
    "/",
    wrap(async (req, res) => {
      res.json(await service.circleState(req.rts.ctx, { license: req.rts.license }));
    })
  );

  circle.get(
    "/stream",
    wrap(async (req, res) => {
      const circleId = req.rts.ctx.circle.id;
      const account = req.user.sub;
      if ((openStreams.get(account) || 0) >= STREAMS_PER_ACCOUNT) throw new RtsError(429, "too_many_streams");
      const after = Number(req.query.after || 0);
      res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      openStreams.set(account, (openStreams.get(account) || 0) + 1);
      let last = after;
      const send = (seq) => {
        if (seq <= last) return;
        last = seq;
        res.write(`event: change\ndata: ${JSON.stringify({ seq })}\n\n`);
      };
      res.write("retry: 5000\n\n");
      // Listen first, then read, so a change committed in between is not missed.
      const unsubscribe = hub.subscribe(circleId, send);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
      const lifetime = setTimeout(() => res.end(), 30 * 60 * 1000);
      heartbeat.unref?.();
      lifetime.unref?.();
      let closed = false;
      req.on("close", () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        const count = (openStreams.get(account) || 1) - 1;
        if (count > 0) openStreams.set(account, count);
        else openStreams.delete(account);
      });
      const row = await db("rts_circles").select("seq").where({ id: circleId }).first();
      if (row) send(Number(row.seq));
    })
  );

  circle.patch(
    "/",
    wrap(async (req, res) => {
      res.json(await service.updateCircle(req.rts.ctx, parse(schemas.updateCircleSchema, req.body)));
    })
  );
  circle.post(
    "/invite-code",
    wrap(async (req, res) => {
      res.json(await service.rotateInvite(req.rts.ctx));
    })
  );
  circle.post(
    "/sponsor",
    wrap(async (req, res) => {
      const license = await licenseFor(req.user.sub);
      if (!license.active) throw new RtsError(402, "license_required");
      const result = await service.sponsorCircle(req.rts.ctx);
      licenseCache.clear(req.user.sub);
      res.json(result);
    })
  );
  circle.post(
    "/leave",
    wrap(async (req, res) => {
      res.json(await service.leaveCircle(req.rts.ctx));
    })
  );

  circle.post(
    "/members",
    wrap(async (req, res) => {
      res.status(201).json(await service.addMember(req.rts.ctx, parse(schemas.addMemberSchema, req.body)));
    })
  );
  circle.patch(
    "/members/:memberId",
    wrap(async (req, res) => {
      res.json(await service.updateMember(req.rts.ctx, req.params.memberId, parse(schemas.updateMemberSchema, req.body)));
    })
  );
  circle.delete(
    "/members/:memberId",
    wrap(async (req, res) => {
      res.json(await service.removeMember(req.rts.ctx, req.params.memberId));
    })
  );

  circle.post(
    "/quests",
    wrap(async (req, res) => {
      res.status(201).json(await service.createQuest(req.rts.ctx, parse(schemas.questSchema, req.body)));
    })
  );
  circle.patch(
    "/quests/:questId",
    wrap(async (req, res) => {
      res.json(await service.updateQuest(req.rts.ctx, req.params.questId, parse(schemas.questPatchSchema, req.body)));
    })
  );
  circle.delete(
    "/quests/:questId",
    wrap(async (req, res) => {
      res.json(await service.archiveQuest(req.rts.ctx, req.params.questId));
    })
  );
  circle.post(
    "/quests/:questId/claim",
    wrap(async (req, res) => {
      res.status(201).json(await service.claimQuest(req.rts.ctx, req.params.questId, parse(schemas.claimSchema, req.body)));
    })
  );
  circle.post(
    "/claims/:claimId/decide",
    wrap(async (req, res) => {
      res.json(await service.decideClaim(req.rts.ctx, req.params.claimId, parse(schemas.decideSchema, req.body)));
    })
  );

  circle.post(
    "/gifts",
    wrap(async (req, res) => {
      res.json(await service.gift(req.rts.ctx, parse(schemas.giftSchema, req.body)));
    })
  );
  circle.get(
    "/ledger",
    wrap(async (req, res) => {
      const memberId = typeof req.query.memberId === "string" ? req.query.memberId : null;
      res.json({ entries: await service.ledger(req.rts.ctx, memberId) });
    })
  );

  circle.post(
    "/paths",
    wrap(async (req, res) => {
      res.status(201).json(await service.createPath(req.rts.ctx, parse(schemas.pathSchema, req.body)));
    })
  );
  circle.get(
    "/paths/:pathId",
    wrap(async (req, res) => {
      res.json(await service.getPath(req.rts.ctx, req.params.pathId));
    })
  );
  circle.patch(
    "/paths/:pathId",
    wrap(async (req, res) => {
      res.json(await service.updatePath(req.rts.ctx, req.params.pathId, parse(schemas.pathPatchSchema, req.body)));
    })
  );
  circle.delete(
    "/paths/:pathId",
    wrap(async (req, res) => {
      res.json(await service.archivePath(req.rts.ctx, req.params.pathId));
    })
  );
  circle.post(
    "/paths/:pathId/open",
    wrap(async (req, res) => {
      const result = await service.openPath(req.rts.ctx, req.params.pathId, parse(schemas.openPathSchema, req.body));
      res.status(result.resumed ? 200 : 201).json(result);
    })
  );

  circle.get(
    "/runs/:runId",
    wrap(async (req, res) => {
      res.json(await service.getRun(req.rts.ctx, req.params.runId));
    })
  );
  circle.post(
    "/runs/:runId/step",
    wrap(async (req, res) => {
      res.json(await service.step(req.rts.ctx, req.params.runId, parse(schemas.stepSchema, req.body)));
    })
  );
  circle.post(
    "/runs/:runId/fulfill",
    wrap(async (req, res) => {
      res.json(await service.fulfill(req.rts.ctx, req.params.runId, parse(schemas.fulfillSchema, req.body)));
    })
  );
  circle.post(
    "/runs/:runId/cancel",
    wrap(async (req, res) => {
      res.json(await service.cancelRun(req.rts.ctx, req.params.runId));
    })
  );

  router.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (error instanceof RtsError) return res.status(error.status).json({ error: error.code, ...error.extra });
    if (error instanceof ZodError) return res.status(400).json({ error: "invalid_input", issues: schemas.issues(error) });
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (error instanceof SyntaxError || error?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid_json" });
    }
    if (error?.code === "22P02") return res.status(404).json({ error: "not_found" });
    logger.error("[rts] request_failed", error?.code || "", String(error?.message || error).slice(0, 200));
    return res.status(500).json({ error: "server_error" });
  });

  return router;
}
