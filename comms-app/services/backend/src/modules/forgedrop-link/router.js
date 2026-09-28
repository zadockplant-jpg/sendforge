/**
 * DropForge phone link: the signaling relay (ForgeDrop/docs/phone-link.md).
 *
 * A phone's browser and a DropForge desktop use this only to swap WebRTC
 * offers and answers; the data channel then runs directly across the local
 * network and never touches this server. What passes through here is SDP,
 * held in memory for at most a minute.
 *
 *   POST /desktop/poll     desktop  long-poll for messages, and be online
 *   POST /desktop/offline  desktop  stop being online, now
 *   GET  /desktop/peers    desktop  the account's other DropForge machines
 *   GET  /desktops         phone    the account's DropForge machines
 *   POST /phone/poll       phone    long-poll for messages, and be present
 *   POST /signal           either   send an offer, answer or bye; between
 *                                   two desktops, a dial, its answer or bye
 *   POST /code/open        desktop  open a code: the number at its front
 *   POST /code/claim       desktop  claim someone's code, starting a session
 *   POST /code/signal      desktop  a message to the session's other side
 *   POST /code/close       desktop  withdraw a code, or end a session
 *   GET  /person/me        desktop  its own address: its account's email
 *   POST /person/knock     desktop  knock on someone's address, an email
 *   POST /person/signal    desktop  a message to the session's other side
 *   POST /person/close     desktop  end a session
 *   POST /person/end       desktop  a send's knock is over: sent or cancelled
 *   POST /person/invite    page     what an emailed approval link is for
 *   POST /person/approve   page     approve it
 *   POST /person/request   desktop  ask someone for files, by their email
 *   POST /request/open     page     what an emailed request's link is for
 *   POST /request/poll     page     its long-poll, as a guest of the asker
 *   POST /request/signal   page     an offer or bye to the desktop that asked
 *   POST /share/create     phone    a room for sending to someone by a link
 *   POST /share/end        phone    end it: cancelled, or sent
 *   POST /share/open       page     who is sending, and whether their page is open
 *   POST /share/poll       page     its long-poll, as a guest of the sender
 *   POST /share/signal     page     an offer or bye to the sending page
 *   POST /share/received   page     a transfer through it has finished
 *
 * Desktops of one account also swap connection candidates here to reach each
 * other across the internet (DropForge 1.4); the files then go directly
 * between them, never through this server.
 *
 * Codes (DropForge 1.5) introduce two desktops that need not share an
 * account, for sending to someone who is not one of your own computers.
 * codes.js explains how; the files still go directly, never through here.
 *
 * People (DropForge 1.7) introduce them by the email of an account instead,
 * with this server vouching for who is who. people.js explains how; the files
 * still go directly, never through here. From 1.8 a send to someone's account
 * waits for their computers and emails them a link to approve it, whose page
 * (the website's /r/) calls /person/invite and /person/approve. From 1.9 a
 * desktop can ask someone for files: requests.js keeps the request, which is
 * emailed as a link to the website's /s/, and that page, on the phone of the
 * one asked, reaches the asking desktop as the phone link does, as a guest of
 * the asking account. The desktop answers it through /signal.
 *
 * Share links (ForgeDrop/docs/share.md) need no desktop at all: an owner's
 * phone page sends to anyone, who needs no account. shares.js keeps the room,
 * whose link the phone sends from its own email or number, and the page it
 * opens (the website's /g/) reaches the sending page as a guest of the
 * sender's account. The phone answers it through /signal, the only guest a
 * phone ever may. Whether the address is a paid account is said to the sender;
 * one that is not gets one free transfer, kept in the database
 * (freeTransfers.js).
 *
 * A desktop signs in with its offline licence (auth.js), a phone with the
 * customer's Bearer token. Either way the account must own DropForge. The
 * pages an email opens sign in with nothing: the token their link carries is
 * the key, as a share's id is for its page.
 */

import express from "express";
import { createRateLimiter, rateLimitByIp } from "../../middleware/rateLimit.js";
import { licensedProduct } from "../../services/licensedProducts.js";
import { ensureReferralCodeForUser } from "../../services/referrals/referral.service.js";
import { createDesktopAuth, hasLicenceHeader } from "./auth.js";
import { createCodeStore } from "./codes.js";
import { createAccountDirectory, createDeviceDirectory } from "./devices.js";
import { createFreeTransfers } from "./freeTransfers.js";
import { createPeopleStore } from "./people.js";
import { createRequestStore } from "./requests.js";
import {
  answersPhones,
  canonicalUuid,
  cleanText,
  CODE_LIMITS,
  CODE_TYPES,
  DESKTOP_TO_DESKTOP_TYPES,
  GUEST_TYPES,
  isApprovalToken,
  isClientId,
  isCodeSession,
  isPersonSession,
  isPlainObject,
  isRequestToken,
  isSession,
  isShareId,
  KNOCK_OUTCOMES,
  KNOCK_PURPOSES,
  LINK_LIMITS,
  parseAddress,
  parseCaps,
  parseEmail,
  parseMessage,
  parseMinutes,
  parseNameplate,
  parseSummary,
  parseWait,
  PERSON_LIMITS,
  PERSON_TYPES,
  PHONE_TO_GUEST_TYPES,
  SENDABLE_TYPES,
  SHARE_LIMITS,
  takesDials,
  takesGuests,
  takesPeople,
} from "./shapes.js";
import { createShareStore } from "./shares.js";
import { createLinkStore } from "./store.js";

export { CODE_LIMITS, LINK_LIMITS, PERSON_LIMITS, SHARE_LIMITS };

// How the code and person stores' refusals reach the client. A 404 is the
// same answer whether the thing never existed, has run out or belongs to
// someone else. The caps are 409, not 429: waiting does not lift them, only
// closing a code does, and a session's messages never come back.
const REFUSALS = Object.freeze({
  code_unknown: 404,
  code_gone: 404,
  person_gone: 404,
  invite_gone: 404,
  request_gone: 404,
  share_gone: 404,
  too_many_codes: 409,
  too_many_messages: 409,
  invite_over: 409,
  share_taken: 409,
  free_transfer_used: 409,
});

// An account id no account has. A knock on an address nobody has asks the
// database about it all the same, so how long a knock takes says nothing
// about who has an account.
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** Whether a body field was given at all; null counts as not given. */
const given = (value) => value !== undefined && value !== null;

/** A body only counts once it has bytes in it; an empty POST is fine. */
function sentBody(req) {
  const length = Number(req.headers["content-length"]);
  return req.headers["transfer-encoding"] !== undefined || (Number.isFinite(length) && length > 0);
}

export function createForgeDropLinkRouter({
  db,
  requireAuth,
  hasProductEntitlement,
  signingKey,
  now = Date.now,
  store: givenStore = null,
  codes: givenCodes = null,
  people: givenPeople = null,
  // A waiting send's email (1.8), sendForgeDropTransferEmail in production;
  // without one, no email goes.
  sendTransferEmail = null,
  // The approval page an email links to, with the token after the "#".
  approvalLink = (token) => `https://sendforge.app/r/#${token}`,
  // Requests for files (1.9): their store, their email
  // (sendForgeDropFileRequestEmail in production; without one, none goes),
  // and the page the email links to, with the token after the "#".
  requests: givenRequests = null,
  sendRequestEmail = null,
  requestLink = (token) => `https://sendforge.app/s/#${token}`,
  // Share links (share.md): their rooms, and the free transfers of addresses
  // that are not paid accounts, kept by a keyed hash whose key is derived from
  // this secret (JWT_SECRET in production). Without one, a share for an
  // address that is not a paid account answers 503.
  shares: givenShares = null,
  freeTransfers: givenFreeTransfers = null,
  freeTransferSecret = () => "",
  rate = {},
  rateLimitPrefix = "forgedrop-link",
  log = () => {},
}) {
  const product = licensedProduct("forgedrop");
  if (!product) throw new Error("forgedrop is not a licensed product");

  const store =
    givenStore ||
    createLinkStore({
      now,
      onError: (error) =>
        log("error", "forgedrop_link_reply_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  // Code messages travel in the same mailboxes as everything else, so a
  // desktop reads them in the poll it already makes.
  const codes =
    givenCodes ||
    createCodeStore({
      now,
      deliver: (userId, address, message) => store.deliver(userId, address, message),
      onError: (error) =>
        log("error", "forgedrop_link_code_sweep_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  // A knock and what follows it travel in the same mailboxes too. A send's
  // knock waits only while the desktop that knocked is polling.
  const people =
    givenPeople ||
    createPeopleStore({
      now,
      deliver: (userId, address, message) => store.deliver(userId, address, message),
      present: (userId, address) => store.isPresent(userId, address),
      onError: (error) =>
        log("error", "forgedrop_link_person_sweep_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  const requests =
    givenRequests ||
    createRequestStore({
      now,
      onError: (error) =>
        log("error", "forgedrop_link_request_sweep_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  const shares =
    givenShares ||
    createShareStore({
      now,
      onError: (error) =>
        log("error", "forgedrop_link_share_sweep_failed", { message: String(error?.message || error).slice(0, 200) }),
    });
  const freeTransfers = givenFreeTransfers || createFreeTransfers({ db, secret: freeTransferSecret, now });
  const limits = { ...LINK_LIMITS.rate, ...CODE_LIMITS.rate, ...PERSON_LIMITS.rate, ...SHARE_LIMITS.rate, ...rate };
  const devices = createDeviceDirectory(db, product.slug);
  const accounts = createAccountDirectory(db);
  const owns = (userId) => hasProductEntitlement(userId, product.entitlementSlug || product.slug);
  const router = express.Router();

  // Express 4 does not catch a rejected promise, and on Node 20 an unhandled
  // rejection ends the process: every async handler goes through here.
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  const unavailable = (res, what, error) => {
    log("error", what, { message: String(error?.message || error).slice(0, 200) });
    return res.status(503).json({ error: "link_unavailable" });
  };

  const desktopAuth = wrap(
    createDesktopAuth({
      signingKey,
      product: product.slug,
      devices,
      hasEntitlement: owns,
      now,
      ttlMs: LINK_LIMITS.licenceCacheMs,
      log,
    })
  );

  // The existing customer sign-in, unchanged, then the phone's identity. The
  // account id is spelled the way the licence's uid is, so a phone and its
  // account's desktops always meet under the same key.
  const phoneAuth = (req, res, next) =>
    Promise.resolve(
      requireAuth(req, res, (error) => {
        if (error) return next(error);
        const sub = String(req.user.sub);
        req.link = { kind: "phone", userId: canonicalUuid(sub) || sub };
        return next();
      })
    ).catch(next);

  // Ownership for phones is read on every request. It runs after the rate
  // limiter so a busy client costs a counter, not a query.
  const requireForgeDrop = wrap(async (req, res, next) => {
    if (req.link.kind !== "phone") return next();
    let owned;
    try {
      owned = await owns(req.link.userId);
    } catch (error) {
      return unavailable(res, "forgedrop_link_entitlement_check_failed", error);
    }
    if (!owned) return res.status(403).json({ error: "entitlement_required" });
    return next();
  });

  const limiter = (name, max, keyGenerator, windowMs = 60 * 1000) =>
    createRateLimiter({
      name: `${rateLimitPrefix}-${name}`,
      windowMs,
      max,
      keyGenerator,
      message: "rate_limited",
    });
  const signalLimiter = limiter("signal", limits.signalPerMinute, (req) => req.link.userId);
  const desktopPollLimiter = limiter(
    "desktop-poll",
    limits.pollPerMinute,
    (req) => `${req.link.userId}:${req.link.address}`
  );
  // Keyed on the clientId as sent, before it is validated, so the limit
  // applies ahead of the ownership query. The limiter hashes it.
  const phonePollLimiter = limiter(
    "phone-poll",
    limits.pollPerMinute,
    (req) => `${req.link.userId}:phone:${String(req.body?.clientId ?? "")}`
  );
  const desktopsLimiter = limiter("desktops", limits.desktopsPerMinute, (req) => req.link.userId);
  const codeOpenLimiter = limiter(
    "code-open",
    limits.codeOpenPerMinute,
    (req) => `${req.link.userId}:${req.link.address}`
  );
  // Per account, not per desktop: a second licence does not buy a second
  // allowance of guesses. Every claim counts, whatever its answer.
  const codeClaimLimiter = limiter("code-claim", limits.codeClaimPerMinute, (req) => req.link.userId);
  const codeSignalLimiter = limiter("code-signal", limits.codeSignalPerMinute, (req) => req.link.userId);
  // Per account, like claims: a second licence does not buy a second
  // allowance of knocks. Every knock counts, whatever its answer.
  const knockLimiter = limiter("person-knock", limits.knockPerMinute, (req) => req.link.userId);
  const personSignalLimiter = limiter("person-signal", limits.personSignalPerMinute, (req) => req.link.userId);
  // A desktop's own address is read from the database, so asking for it is
  // limited like the desktop list, with an allowance of its own.
  const personMeLimiter = limiter("person-me", limits.desktopsPerMinute, (req) => req.link.userId);
  // The approval page signs in with nothing, so it is limited by the address
  // it calls from, its two routes together.
  const inviteLimiter = limiter("person-invite", limits.invitePerMinute, rateLimitByIp);
  // Asking for files emails someone else, so it is limited per account, as
  // knocking is.
  const requestLimiter = limiter("person-request", limits.requestPerMinute, (req) => req.link.userId);
  // A request's page signs in with nothing: limited by the address it calls
  // from, its three routes together, and its polls per clientId as well, as a
  // phone's are (keyed as sent, before it is checked; the limiter hashes it).
  const requestPageLimiter = limiter("request-page", limits.requestPagePerMinute, rateLimitByIp);
  const guestPollLimiter = limiter(
    "request-poll",
    limits.requestPagePerMinute,
    (req) => `guest:${String(req.body?.clientId ?? "")}`
  );
  // Making a share room says whether an address is a paid account: 20 an
  // hour per account, whichever of its phone pages makes them. Every request
  // counts, whatever its answer, and before the ownership query.
  const shareCreateLimiter = limiter(
    "share-create",
    limits.shareCreatePerHour,
    (req) => req.link.userId,
    60 * 60 * 1000
  );
  const shareEndLimiter = limiter("share-end", limits.shareEndPerMinute, (req) => req.link.userId);
  // A share's page signs in with nothing, as a request's does: limited by the
  // address it calls from, its four routes together, and its polls per
  // clientId as well (keyed as sent, before it is checked; the limiter hashes
  // it). Apart from the request pages' allowances.
  const sharePageLimiter = limiter("share-page", limits.sharePagePerMinute, rateLimitByIp);
  const sharePollLimiter = limiter(
    "share-poll",
    limits.sharePagePerMinute,
    (req) => `guest:${String(req.body?.clientId ?? "")}`
  );
  const refuse = (res, error) => res.status(REFUSALS[error] || 400).json({ error });

  /** An account's email as an address: trimmed, in lower case. */
  const addressOf = (email) => String(email).trim().toLowerCase();

  /**
   * What this server vouches for about a desktop: its account's verified
   * email, its name (its poll's, else its device row's) and the identity key
   * it proved it holds, with that key's fingerprint. Read from the database
   * as it is vouched for, never taken from anything an app sent. A refusal
   * names what is missing.
   */
  async function vouchFor({ userId, deviceId, address }) {
    const [account, device] = await Promise.all([accounts.byId(userId), devices.findProven(userId, deviceId)]);
    if (!account?.email || !account.email_verified) return { ok: false, error: "email_unverified" };
    if (!device) return { ok: false, error: "identity_unproven" };
    return {
      ok: true,
      card: {
        email: addressOf(account.email),
        name: store.presence(userId, address)?.name ?? device.name,
        identity: device.identity,
        fingerprint: device.fingerprint,
      },
    };
  }

  /**
   * Who a knock on `address` is for: the account whose verified email it is,
   * if that account owns DropForge, as { userId, email }, and the desktops of
   * it the knock lands on now: those that hold a slot, have proved their key
   * and are polling saying they take people, never the desktop knocking. No
   * such account and not an owner come back as nobody, and nobody online as
   * no desktops, all after the same three questions to the database.
   */
  async function recipientsOf(address, sender) {
    const account = await accounts.findVerified(address);
    const userId = account ? canonicalUuid(String(account.id)) || String(account.id) : NOBODY;
    const [owned, desktops] = await Promise.all([owns(userId), devices.listProven(userId)]);
    if (!account || !owned) return { account: null, desktops: [] };
    return {
      account: { userId, email: account.email },
      desktops: desktops
        .map(({ deviceId }) => ({
          userId,
          address: `desktop:${canonicalUuid(String(deviceId)) || String(deviceId)}`,
        }))
        .filter((party) => !(party.userId === sender.userId && party.address === sender.address))
        .filter((party) => takesPeople(store.presence(party.userId, party.address))),
    };
  }

  /**
   * Before a desktop's poll reads its mailbox: the sends waiting for its
   * account (1.8) that it has not had since it came online, if it takes
   * people and, as a knock's recipients must, holds a slot and a proven key.
   * With nothing waiting for its account, this is one lookup in memory; the
   * database is asked only when something is due. A failed check never
   * fails the poll: what was due stays due for the next one.
   */
  async function knockWaiting(link, info) {
    const { userId, deviceId, address } = link;
    if (!people.waitsFor(userId)) return;
    const cameOnline = !store.isPresent(userId, address);
    store.touch(userId, address, info);
    if (cameOnline) people.cameOnline(userId, address);
    if (!takesPeople(store.presence(userId, address))) return;

    const due = people.claimWaiting(link);
    if (!due.length) return;
    let proven;
    try {
      proven = await devices.findProven(userId, deviceId);
    } catch (error) {
      people.releaseWaiting(link, due);
      log("error", "forgedrop_link_waiting_check_failed", { message: String(error?.message || error).slice(0, 200) });
      return;
    }
    if (proven) people.deliverWaiting(link, due);
    else people.releaseWaiting(link, due);
  }

  /**
   * Email the account a send waits for (1.8). Called once the knock has been
   * answered, so a knock takes as long whether or not an email goes. At most
   * one per sender and recipient every 2 minutes and 10 an hour per
   * recipient; over that the knock still knocks, only without an email. A
   * failure is logged, and the link, which approves, never is.
   */
  function emailWaiting({ sender, account, card, summary, knock, token }) {
    if (!sendTransferEmail || !people.mayEmail(sender.userId, account.userId)) return;
    Promise.resolve()
      .then(() =>
        sendTransferEmail({
          to: account.email,
          senderEmail: card.email,
          senderComputer: card.name,
          files: summary.files,
          bytes: summary.bytes,
          approveUrl: approvalLink(token),
          knockId: knock,
        })
      )
      .catch((error) =>
        log("error", "forgedrop_link_transfer_email_failed", {
          code: error?.code ?? null,
          message: String(error?.message || error).slice(0, 200),
        })
      );
  }

  /**
   * Email the account a request asks for files (1.9), once the request has
   * been answered, so it takes as long whether or not an email goes. The
   * same limits as a waiting send's email, counted apart from them; over
   * them the request is kept, only not emailed. A failure is logged, and the
   * link, which opens the request, never is.
   */
  function emailRequest({ sender, account, card, message, request, token }) {
    if (!sendRequestEmail || !requests.mayEmail(sender.userId, account.userId)) return;
    Promise.resolve()
      .then(() =>
        sendRequestEmail({
          to: account.email,
          askerEmail: card.email,
          askerComputer: card.name,
          message,
          requestUrl: requestLink(token),
          fileRequestId: request,
        })
      )
      .catch((error) =>
        log("error", "forgedrop_link_request_email_failed", {
          code: error?.code ?? null,
          message: String(error?.message || error).slice(0, 200),
        })
      );
  }

  function longPoll(res, userId, address, waitSeconds, info) {
    if (res.destroyed) return;
    const release = store.poll(userId, address, {
      info,
      waitMs: Math.round(waitSeconds * 1000),
      isAlive: () => !res.writableEnded && !res.destroyed,
      respond: (messages) => res.status(200).json({ messages }),
    });
    // The response's close, not the request's: on Node 20 a request emits
    // 'close' as soon as its body has been read, with the client still
    // connected. The response closes when it is sent or when the client
    // hangs up; after a send, releasing is a no-op.
    res.once("close", release);
  }

  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Lets the browser app read how long to back off after a 429.
      "Access-Control-Expose-Headers": "Retry-After",
    });
    next();
  });

  // JSON only. Without this, a client that forgets its Content-Type (Python's
  // urllib sends form encoding by default) would have its body eaten by the
  // app-wide form parser and fail in confusing ways further down.
  router.use((req, res, next) => {
    if (sentBody(req) && !req.is("application/json")) {
      return res.status(415).json({ error: "json_required" });
    }
    return next();
  });
  router.use(express.json({ limit: LINK_LIMITS.bodyBytes, strict: true }));

  // ------------------------------------------------------------- desktop

  router.post(
    "/desktop/poll",
    desktopAuth,
    desktopPollLimiter,
    wrap(async (req, res) => {
      const body = req.body || {};
      const waitSeconds = parseWait(body.wait);
      if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
      const info = {
        name: cleanText(body.name, 64),
        fingerprint: cleanText(body.fingerprint, 32),
        appVersion: cleanText(body.appVersion, 32),
        caps: parseCaps(body.caps),
      };
      await knockWaiting(req.link, info);
      return longPoll(res, req.link.userId, req.link.address, waitSeconds, info);
    })
  );

  router.post("/desktop/offline", desktopAuth, (req, res) => {
    store.drop(req.link.userId, req.link.address);
    res.status(204).end();
  });

  // The account's other desktops, for one to dial another across the
  // internet. Online only while it polls saying it takes dials. The
  // fingerprint is the proven one where there is one: that is what the app
  // matches against the computers it paired with.
  router.get(
    "/desktop/peers",
    desktopAuth,
    desktopsLimiter,
    wrap(async (req, res) => {
      const { userId, address } = req.link;
      let rows;
      try {
        rows = await devices.listActive(userId);
      } catch (error) {
        return unavailable(res, "forgedrop_link_device_list_failed", error);
      }
      const desktops = rows
        .map((row) => {
          const deviceId = canonicalUuid(String(row.device_id)) || String(row.device_id);
          const live = store.presence(userId, `desktop:${deviceId}`);
          const proven = Boolean(row.identity_verified_at && row.identity_fingerprint);
          return {
            deviceId,
            address: `desktop:${deviceId}`,
            name: live?.name ?? row.device_name ?? null,
            fingerprint: proven ? row.identity_fingerprint : live?.fingerprint ?? row.identity_fingerprint ?? null,
            fingerprintVerified: proven,
            appVersion: live?.appVersion ?? row.app_version ?? null,
            online: takesDials(live),
          };
        })
        .filter((desktop) => desktop.address !== address);
      return res.json({ desktops });
    })
  );

  // --------------------------------------------------------------- phone

  router.get(
    "/desktops",
    phoneAuth,
    desktopsLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const userId = req.link.userId;
      let rows;
      try {
        rows = await devices.listActive(userId);
      } catch (error) {
        return unavailable(res, "forgedrop_link_device_list_failed", error);
      }

      const desktops = rows.map((row) => {
        const deviceId = canonicalUuid(String(row.device_id)) || String(row.device_id);
        // A desktop polling only to take dials from its other desktops does
        // not answer phones: to a phone it is offline.
        const polled = store.presence(userId, `desktop:${deviceId}`);
        const live = answersPhones(polled) ? polled : null;
        const fingerprint = live?.fingerprint ?? row.identity_fingerprint ?? null;
        return {
          deviceId,
          name: live?.name ?? row.device_name ?? null,
          fingerprint,
          // Proven only when the device showed it holds that very key
          // (identityProof.service.js); anything else is its own say-so.
          fingerprintVerified: Boolean(
            row.identity_verified_at && fingerprint && fingerprint === row.identity_fingerprint
          ),
          appVersion: live?.appVersion ?? row.app_version ?? null,
          platform: row.platform ?? null,
          online: Boolean(live),
        };
      });
      desktops.sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          Number(a.name === null) - Number(b.name === null) ||
          String(a.name ?? "").localeCompare(String(b.name ?? ""), "en", { sensitivity: "base" }) ||
          a.deviceId.localeCompare(b.deviceId)
      );
      return res.json({ desktops });
    })
  );

  router.post("/phone/poll", phoneAuth, phonePollLimiter, requireForgeDrop, (req, res) => {
    const body = req.body || {};
    if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
    const waitSeconds = parseWait(body.wait);
    if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
    return longPoll(res, req.link.userId, `phone:${body.clientId}`, waitSeconds, null);
  });

  // -------------------------------------------------------------- either

  router.post(
    "/signal",
    (req, res, next) => (hasLicenceHeader(req) ? desktopAuth : phoneAuth)(req, res, next),
    signalLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const body = req.body || {};
      const sender = req.link;
      const userId = sender.userId;

      const to = parseAddress(body.to);
      if (!to) return res.status(400).json({ error: "bad_recipient" });
      // A phone page reaches a guest only when that guest has claimed one of
      // that very page's share rooms, to answer it or say bye. Every other
      // guest, a request page's (1.9) among them, is never reached from a
      // phone: it is answered by its account's desktops.
      let ownGuest = false;
      if (to.kind === "guest" && sender.kind !== "desktop") {
        const page = parseAddress(body.from);
        if (!page || page.kind !== "phone" || !shares.answers({ userId, address: page.address }, to.id)) {
          return res.status(400).json({ error: "bad_recipient" });
        }
        ownGuest = true;
      }
      // Phone to phone never; desktop to desktop only to dial (below), and
      // never to itself.
      const betweenDesktops = sender.kind === "desktop" && to.kind === "desktop";
      if ((to.kind === sender.kind && !betweenDesktops) || to.address === sender.address) {
        return res.status(400).json({ error: "bad_recipient" });
      }

      let from = sender.address;
      if (sender.kind === "phone") {
        const claimed = parseAddress(body.from);
        if (!claimed || claimed.kind !== "phone") return res.status(400).json({ error: "bad_sender" });
        from = claimed.address;
      }

      if (!isSession(body.session)) return res.status(400).json({ error: "bad_session" });
      let allowed = SENDABLE_TYPES[sender.kind];
      if (betweenDesktops) allowed = DESKTOP_TO_DESKTOP_TYPES;
      else if (ownGuest) allowed = PHONE_TO_GUEST_TYPES;
      if (!allowed.has(body.type)) return res.status(400).json({ error: "bad_type" });

      const data = body.data === undefined ? {} : body.data;
      if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
        return res.status(413).json({ error: "data_too_large" });
      }

      // Addresses live under the sender's own account, so another account's
      // desktop or phone is simply not there to find.
      if (to.kind === "desktop") {
        if (!store.isPresent(userId, to.address)) return res.status(404).json({ error: "desktop_offline" });
        // Dialled only while it says it takes dials; answered phones only
        // while it says it answers phones.
        const live = store.presence(userId, to.address);
        if (betweenDesktops ? !takesDials(live) : !answersPhones(live)) {
          return res.status(404).json({ error: "desktop_offline" });
        }
        let active;
        try {
          active = await devices.findActive(userId, to.id);
        } catch (error) {
          return unavailable(res, "forgedrop_link_device_check_failed", error);
        }
        // Online but no longer holding a slot: freed on the account page
        // within the last minute, while its licence check was still cached.
        if (!active) return res.status(404).json({ error: "desktop_offline" });
      } else if (!store.isPresent(userId, to.address)) {
        return res.status(404).json({ error: "phone_gone" });
      }

      store.deliver(userId, to.address, {
        from,
        session: body.session,
        type: body.type,
        data,
        sentAt: new Date(now()).toISOString(),
      });
      // A phone that just spoke is there. Its answer can then arrive before
      // its first poll does without being turned away as phone_gone.
      if (sender.kind === "phone") store.touch(userId, from);
      return res.status(202).json({ ok: true });
    })
  );

  // --------------------------------------------------------------- codes
  //
  // Desktops only: only activated DropForge computers can open or claim a
  // code, so guessing at scale costs licences. The two sides of a code may
  // belong to different accounts; codes.js keeps each one's mail in its own.

  router.post("/code/open", desktopAuth, codeOpenLimiter, (req, res) => {
    const body = req.body || {};
    const minutes = parseMinutes(body.minutes);
    if (minutes === null) return res.status(400).json({ error: "bad_minutes" });
    const opened = codes.open(req.link, { minutes, name: cleanText(body.name, 64) });
    if (!opened.ok) return refuse(res, opened.error);
    return res.json({ nameplate: opened.nameplate, expiresAt: new Date(opened.expiresAt).toISOString() });
  });

  router.post("/code/claim", desktopAuth, codeClaimLimiter, (req, res) => {
    const number = parseNameplate((req.body || {}).nameplate);
    if (number === null) return res.status(400).json({ error: "bad_nameplate" });
    const claimed = codes.claim(req.link, number);
    if (!claimed.ok) return refuse(res, claimed.error);
    // Something to show while the PAKE runs: the name the creator gave with
    // its code, else what its poll says. Only a label; the name the app
    // believes arrives in the PAKE, vouched for by the code.
    const { userId, address } = claimed.creator;
    const name = claimed.name ?? store.presence(userId, address)?.name ?? null;
    return res.json({ session: claimed.session, peer: { name } });
  });

  router.post("/code/signal", desktopAuth, codeSignalLimiter, (req, res) => {
    const body = req.body || {};
    if (!isCodeSession(body.session)) return res.status(400).json({ error: "bad_session" });
    if (!CODE_TYPES.has(body.type)) return res.status(400).json({ error: "bad_type" });
    const data = body.data === undefined ? {} : body.data;
    if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
      return res.status(413).json({ error: "data_too_large" });
    }
    const sent = codes.signal(req.link, body.session, body.type, data);
    if (!sent.ok) return refuse(res, sent.error);
    return res.status(202).json({ ok: true });
  });

  // One of the two, never both: a nameplate nobody has claimed yet, or a
  // session. A 404 here says it was already over, or never this desktop's.
  router.post("/code/close", desktopAuth, (req, res) => {
    const body = req.body || {};
    const bySession = given(body.session);
    if (bySession === given(body.nameplate)) return res.status(400).json({ error: "bad_request" });
    let closed;
    if (bySession) {
      if (!isCodeSession(body.session)) return res.status(400).json({ error: "bad_session" });
      closed = codes.closeSession(req.link, body.session);
    } else {
      const number = parseNameplate(body.nameplate);
      if (number === null) return res.status(400).json({ error: "bad_nameplate" });
      closed = codes.closeNameplate(req.link, number);
    }
    if (!closed.ok) return refuse(res, closed.error);
    return res.status(204).end();
  });

  // -------------------------------------------------------------- people
  //
  // Desktops only, like codes. A person's address is the email of the
  // account their DropForge is activated with; the two sides may belong to
  // different accounts, and people.js keeps each one's mail in its own. What
  // this server vouches for (ForgeDrop/docs/people.md, "What is trusted") is
  // read from the database as it is said, never taken from an app.

  router.get(
    "/person/me",
    desktopAuth,
    personMeLimiter,
    wrap(async (req, res) => {
      let account;
      try {
        account = await accounts.byId(req.link.userId);
      } catch (error) {
        return unavailable(res, "forgedrop_link_person_me_failed", error);
      }
      return res.json({
        email: account?.email ? addressOf(account.email) : null,
        verified: Boolean(account?.email && account.email_verified),
      });
    })
  );

  // The answer is the same whether or not the address has anyone: a knock
  // id, so nobody can use a knock to learn who has an account. Only what is
  // wrong with the knock itself, or with the one knocking, is refused. A send
  // to someone's account that says how many files and bytes it sends (1.8)
  // also waits for their computers and emails them, neither of which the
  // answer shows. One that does not (DropForge 1.7, which gives up after 15 s
  // and never ends a knock) knocks only on the desktops there now, as 1.7
  // did: an email about it would promise a transfer that is not coming.
  router.post(
    "/person/knock",
    desktopAuth,
    knockLimiter,
    wrap(async (req, res) => {
      const body = req.body || {};
      const to = parseEmail(body.to);
      if (!to) return res.status(400).json({ error: "bad_email" });
      if (!KNOCK_PURPOSES.has(body.purpose)) return res.status(400).json({ error: "bad_purpose" });
      const summary = parseSummary(body);
      if (!summary) return res.status(400).json({ error: "bad_summary" });

      let sender;
      let found = { account: null, desktops: [] };
      try {
        sender = await vouchFor(req.link);
        if (sender.ok) found = await recipientsOf(to, req.link);
      } catch (error) {
        return unavailable(res, "forgedrop_link_knock_failed", error);
      }
      if (!sender.ok) return res.status(409).json({ error: sender.error });

      const waits =
        body.purpose === "send" && found.account !== null && summary.files !== null && summary.bytes !== null;
      const { knock, token } = people.knock(req.link, {
        purpose: body.purpose,
        card: sender.card,
        recipients: found.desktops,
        waitFor: waits ? { userId: found.account.userId, ...summary } : null,
      });
      // The email starts only after the answer has gone.
      const answered = res.status(202).json({ knock });
      if (token) emailWaiting({ sender: req.link, account: found.account, card: sender.card, summary, knock, token });
      return answered;
    })
  );

  router.post(
    "/person/signal",
    desktopAuth,
    personSignalLimiter,
    wrap(async (req, res) => {
      const body = req.body || {};
      if (!isPersonSession(body.session)) return res.status(400).json({ error: "bad_session" });
      if (!PERSON_TYPES.has(body.type)) return res.status(400).json({ error: "bad_type" });
      const data = body.data === undefined ? {} : body.data;
      if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
        return res.status(413).json({ error: "data_too_large" });
      }

      // "here" is the desktop knocked on answering, and what it says is
      // dropped: this server says who it is. Nothing is looked up for anyone
      // who is not the one knocked on.
      let said = data;
      if (body.type === "here") {
        const mine = people.role(req.link, body.session);
        if (!mine) return refuse(res, "person_gone");
        if (mine.role !== "recipient") return res.status(400).json({ error: "bad_type" });
        let recipient;
        try {
          recipient = await vouchFor(req.link);
        } catch (error) {
          return unavailable(res, "forgedrop_link_person_here_failed", error);
        }
        // Knocked on, but no longer anyone this server can vouch for: its
        // slot freed, or its key or email no longer counting. The session
        // ends, and the desktop that knocked never hears of it.
        if (!recipient.ok) {
          people.forget(req.link, body.session);
          return refuse(res, "person_gone");
        }
        said = { knock: mine.knock, ...recipient.card };
      }

      const sent = people.signal(req.link, body.session, body.type, said);
      if (!sent.ok) return refuse(res, sent.error);
      return res.status(202).json({ ok: true });
    })
  );

  router.post("/person/close", desktopAuth, (req, res) => {
    const body = req.body || {};
    if (!isPersonSession(body.session)) return res.status(400).json({ error: "bad_session" });
    const closed = people.closeSession(req.link, body.session);
    if (!closed.ok) return refuse(res, closed.error);
    return res.status(204).end();
  });

  // A send's knock is over (1.8): it stops waiting, and its page says how it
  // ended. The same answer for a knock that never had anyone, or was never
  // this desktop's: which knocks are whose is not said.
  router.post("/person/end", desktopAuth, (req, res) => {
    const body = req.body || {};
    if (!isPersonSession(body.knock)) return res.status(400).json({ error: "bad_knock" });
    if (!KNOCK_OUTCOMES.has(body.outcome)) return res.status(400).json({ error: "bad_outcome" });
    people.end(req.link, body.knock, body.outcome);
    return res.status(204).end();
  });

  // ---------------------------------------------------- the approval page
  //
  // The website's /r/ page, opened from the email a waiting send sent: no
  // licence and no account, the token after the link's "#" is the key. It
  // looks first; only a press of its Approve button approves, because mail
  // scanners open links. A malformed token is as gone as an unknown one.
  // CORS is app.js's, ahead of this router, so the site can call these.

  const tokenOf = (req) => {
    const token = (req.body || {}).token;
    return isApprovalToken(token) ? token : null;
  };

  router.post("/person/invite", inviteLimiter, (req, res) => {
    const found = people.invite(tokenOf(req));
    if (!found.ok) return refuse(res, found.error);
    return res.json(found.invite);
  });

  router.post("/person/approve", inviteLimiter, (req, res) => {
    const approved = people.approve(tokenOf(req));
    if (!approved.ok) return refuse(res, approved.error);
    return res.json(approved.invite);
  });

  // ------------------------------------------------ requests for files (1.9)
  //
  // A desktop asks someone for files by their email. The answer is the same
  // whoever the address is, after the same questions to the database; for a
  // verified owner's address the request is kept a day and emailed to them.
  // Its link opens the website's /s/, which signs in with nothing but the
  // token after the link's "#", and reaches the asking desktop the way a
  // phone does, as the guest "guest:<clientId>" under the asking account: it
  // offers, and the desktop answers through /signal. The page reaches the
  // desktop that asked and nothing else. CORS is app.js's, ahead of this
  // router, so the site can call these.

  router.post(
    "/person/request",
    desktopAuth,
    requestLimiter,
    wrap(async (req, res) => {
      const body = req.body || {};
      const to = parseEmail(body.to);
      if (!to) return res.status(400).json({ error: "bad_email" });
      const message = parseMessage(body.message);
      if (message === undefined) return res.status(400).json({ error: "bad_message" });

      let sender;
      let found = { account: null, desktops: [] };
      try {
        sender = await vouchFor(req.link);
        if (sender.ok) found = await recipientsOf(to, req.link);
      } catch (error) {
        return unavailable(res, "forgedrop_link_file_request_failed", error);
      }
      if (!sender.ok) return res.status(409).json({ error: sender.error });

      const { request, token } = requests.ask(req.link, {
        card: sender.card,
        address: to,
        message,
        keep: found.account !== null,
      });
      // The email starts only after the answer has gone.
      const answered = res.status(202).json({ request });
      if (token) emailRequest({ sender: req.link, account: found.account, card: sender.card, message, request, token });
      return answered;
    })
  );

  /** The request a page's token opens, while it lasts; else null, malformed or not. */
  const requestOf = (req) => {
    const token = (req.body || {}).token;
    return isRequestToken(token) ? requests.byToken(token) : null;
  };

  // Who is asking, and whether their computer can be reached now.
  router.post("/request/open", requestPageLimiter, (req, res) => {
    const request = requestOf(req);
    if (!request) return refuse(res, "request_gone");
    const { userId, address } = request.asker;
    return res.json({
      from: request.card.email,
      name: request.card.name ?? null,
      message: request.message,
      identity: request.card.identity,
      online: takesGuests(store.presence(userId, address)),
    });
  });

  router.post("/request/poll", requestPageLimiter, guestPollLimiter, (req, res) => {
    const body = req.body || {};
    const request = requestOf(req);
    if (!request) return refuse(res, "request_gone");
    if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
    const waitSeconds = parseWait(body.wait);
    if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
    return longPoll(res, request.asker.userId, `guest:${body.clientId}`, waitSeconds, null);
  });

  router.post(
    "/request/signal",
    requestPageLimiter,
    wrap(async (req, res) => {
      const body = req.body || {};
      const request = requestOf(req);
      if (!request) return refuse(res, "request_gone");
      if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
      if (!isSession(body.session)) return res.status(400).json({ error: "bad_session" });
      if (!GUEST_TYPES.has(body.type)) return res.status(400).json({ error: "bad_type" });
      const data = body.data === undefined ? {} : body.data;
      if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
        return res.status(413).json({ error: "data_too_large" });
      }

      // Only to the desktop that asked, while it says it takes phones and
      // still holds its slot.
      const { userId, address } = request.asker;
      if (!takesGuests(store.presence(userId, address))) return res.status(404).json({ error: "desktop_offline" });
      let active;
      try {
        active = await devices.findActive(userId, parseAddress(address)?.id);
      } catch (error) {
        return unavailable(res, "forgedrop_link_device_check_failed", error);
      }
      if (!active) return res.status(404).json({ error: "desktop_offline" });

      const guest = `guest:${body.clientId}`;
      store.deliver(userId, address, {
        from: guest,
        session: body.session,
        type: body.type,
        // Which request this answers, as this server knows it; whatever the
        // page said about that is replaced.
        data: { ...data, request: { id: request.id, email: request.address } },
        sentAt: new Date(now()).toISOString(),
      });
      // A guest that just spoke is there, as a phone that just spoke is: the
      // answer may come before its first poll.
      store.touch(userId, guest);
      return res.status(202).json({ ok: true });
    })
  );

  // ------------------------------------------------- share links (share.md)
  //
  // An owner's phone page sends to anyone, who needs no account. It makes a
  // room and sends its link (the room's id after the "#") from its own email
  // or number; sendforge.app sends nothing. The page the link opens (the
  // website's /g/) signs in with nothing but that id, and reaches the sending
  // page as the guest "guest:<clientId>" under the sender's account: it
  // offers, and the phone answers through /signal. The first page to offer
  // claims the room, and the phone answers that page and no other. CORS is
  // app.js's, ahead of this router, so the site can call these.
  //
  // The sender is told whether the address is a paid account (a verified
  // account that owns DropForge): the owner asked for that, and nothing else
  // here says it. An address that is not gets one free transfer. Once a
  // transfer through its room has finished, either page says so, and a new
  // room for that address is refused.

  /**
   * Whether an address is a paid account: a verified account that owns
   * DropForge. The same two questions to the database whoever it is, as a
   * knock asks them.
   */
  async function isPaid(address) {
    const account = await accounts.findVerified(address);
    const userId = account ? canonicalUuid(String(account.id)) || String(account.id) : NOBODY;
    const owned = await owns(userId);
    return Boolean(account) && Boolean(owned);
  }

  /**
   * The sender's own referral code, for the page's Get DropForge link: the
   * one their account page shows, made the first time it is asked for, as it
   * is there. Null when there is none or it cannot be read; the send goes on
   * without it.
   */
  async function referralOf(userId) {
    try {
      const user = await db("users").where({ id: userId }).first("id", "email", "cash_app_tag");
      if (!user) return null;
      return (await ensureReferralCodeForUser(user, db))?.code ?? null;
    } catch (error) {
      log("error", "forgedrop_link_share_referral_failed", { message: String(error?.message || error).slice(0, 200) });
      return null;
    }
  }

  /**
   * A transfer through `share` has finished: its address's free transfer is
   * used, when it is not a paid account. Only once a page has claimed the
   * room: nothing can have gone through it before that.
   */
  async function spendFreeTransfer(share) {
    if (share.paid || share.recipient === null || share.guest === null) return;
    await freeTransfers.use(share.recipient);
  }

  router.post(
    "/share/create",
    phoneAuth,
    shareCreateLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const body = req.body || {};
      if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
      const name = cleanText(body.name, SHARE_LIMITS.nameChars);
      if (!name) return res.status(400).json({ error: "bad_name" });
      const to = parseEmail(body.to);
      if (!to) return res.status(400).json({ error: "bad_email" });

      const { userId } = req.link;
      let paid;
      let recipient = null;
      try {
        paid = await isPaid(to);
        if (!paid) {
          recipient = freeTransfers.keyOf(to);
          if (await freeTransfers.used(recipient)) return refuse(res, "free_transfer_used");
        }
      } catch (error) {
        return unavailable(res, "forgedrop_link_share_check_failed", error);
      }
      const referral = await referralOf(userId);
      const { share } = shares.create({ userId, address: `phone:${body.clientId}` }, { name, paid, referral, recipient });
      return res.status(201).json({ share, paid, referral });
    })
  );

  // The sender is done with a room: cancelled, or with "sent": true the files
  // went, which uses a free transfer as the page's word does. The same answer
  // for a room that is over or is another account's: which rooms are whose is
  // not said.
  router.post(
    "/share/end",
    phoneAuth,
    shareEndLimiter,
    requireForgeDrop,
    wrap(async (req, res) => {
      const body = req.body || {};
      if (!isShareId(body.share)) return res.status(400).json({ error: "bad_share" });
      if (given(body.sent) && typeof body.sent !== "boolean") return res.status(400).json({ error: "bad_sent" });
      const share = shares.byId(body.share);
      if (share && share.owner.userId === req.link.userId) {
        if (body.sent === true) {
          try {
            await spendFreeTransfer(share);
          } catch (error) {
            return unavailable(res, "forgedrop_link_free_transfer_failed", error);
          }
        }
        shares.end(req.link.userId, share.id);
      }
      return res.json({ ok: true });
    })
  );

  /** The room a page's id opens, while it lasts; else null, malformed or not. */
  const shareOf = (req) => {
    const id = (req.body || {}).share;
    return isShareId(id) ? shares.byId(id) : null;
  };

  // Who is sending, whether their page can be reached now, whether the
  // address it was sent to is a paid account, and the sender's referral code.
  router.post("/share/open", sharePageLimiter, (req, res) => {
    const share = shareOf(req);
    if (!share) return refuse(res, "share_gone");
    const { userId, address } = share.owner;
    return res.json({
      name: share.name,
      online: store.isPresent(userId, address),
      paid: share.paid,
      referral: share.referral,
    });
  });

  router.post("/share/poll", sharePageLimiter, sharePollLimiter, (req, res) => {
    const body = req.body || {};
    const share = shareOf(req);
    if (!share) return refuse(res, "share_gone");
    if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
    const waitSeconds = parseWait(body.wait);
    if (waitSeconds === null) return res.status(400).json({ error: "bad_wait" });
    return longPoll(res, share.owner.userId, `guest:${body.clientId}`, waitSeconds, null);
  });

  router.post("/share/signal", sharePageLimiter, (req, res) => {
    const body = req.body || {};
    const share = shareOf(req);
    if (!share) return refuse(res, "share_gone");
    if (!isClientId(body.clientId)) return res.status(400).json({ error: "bad_client_id" });
    if (!isSession(body.session)) return res.status(400).json({ error: "bad_session" });
    if (!GUEST_TYPES.has(body.type)) return res.status(400).json({ error: "bad_type" });
    const data = body.data === undefined ? {} : body.data;
    if (!isPlainObject(data)) return res.status(400).json({ error: "bad_data" });
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > LINK_LIMITS.dataBytes) {
      return res.status(413).json({ error: "data_too_large" });
    }

    // Once a page has claimed the room it is that page's alone, whether or
    // not the sender is there. Only an offer claims it: a bye before any
    // offer has nothing to end, and reaches nobody.
    if (share.guest !== null && share.guest !== body.clientId) return refuse(res, "share_taken");
    if (share.guest === null && body.type !== "offer") return res.status(202).json({ ok: true });
    // Only to the page that made the room, while it is there. An offer it
    // cannot hear claims nothing.
    const { userId, address } = share.owner;
    if (!store.isPresent(userId, address)) return res.status(404).json({ error: "sender_offline" });
    const claimed = shares.claim(share.id, body.clientId);
    if (!claimed.ok) return refuse(res, claimed.error);

    const guest = `guest:${body.clientId}`;
    store.deliver(userId, address, {
      from: guest,
      session: body.session,
      type: body.type,
      // Which room this is, as this server knows it; whatever the page said
      // about that is replaced.
      data: { ...data, share: { id: share.id } },
      sentAt: new Date(now()).toISOString(),
    });
    // A guest that just spoke is there, as a request's is: the answer may
    // come before its first poll.
    store.touch(userId, guest);
    return res.status(202).json({ ok: true });
  });

  // The page's word that a transfer through the room has finished, which
  // uses the address's free transfer, as the sender's "sent" does. Twice is
  // the same as once.
  router.post(
    "/share/received",
    sharePageLimiter,
    wrap(async (req, res) => {
      const share = shareOf(req);
      if (!share) return refuse(res, "share_gone");
      try {
        await spendFreeTransfer(share);
      } catch (error) {
        return unavailable(res, "forgedrop_link_free_transfer_failed", error);
      }
      return res.json({ ok: true });
    })
  );

  router.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (res.headersSent) return undefined;
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    if (error?.type === "charset.unsupported" || error?.type === "encoding.unsupported") {
      return res.status(415).json({ error: "json_required" });
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: "bad_request" });
    }
    log("error", "forgedrop_link_request_failed", { message: String(error?.message || error).slice(0, 200) });
    return res.status(500).json({ error: "server_error" });
  });

  return router;
}
