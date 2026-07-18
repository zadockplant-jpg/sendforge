import { Router } from "express";
import { db } from "../config/db.js";
import {
  addReferralDestinationSuppression,
  addSuppression,
} from "../services/suppression.service.js";

export const unsubscribeRouter = Router();

function unsubscribeToken(req) {
  const token = String(req.query.token || "").trim();
  return /^[0-9a-f-]{36}$/i.test(token) ? token : "";
}

unsubscribeRouter.get("/", async (req, res) => {
  const token = unsubscribeToken(req);
  if (!token) return res.status(400).send("Missing or invalid token.");

  try {
    const row = await db("unsubscribe_tokens").where({ token }).first();
    if (!row) return res.status(404).send("Invalid token.");

    const action = `/v1/unsubscribe?token=${encodeURIComponent(token)}`;
    return res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stop referral invitations</title></head>
  <body style="font-family:Arial,sans-serif;max-width:540px;margin:48px auto;padding:0 20px;color:#172033">
    <h1>Stop referral invitations?</h1>
    <p>You will stop receiving SendForge Rewards referral invitations.</p>
    <form method="post" action="${action}">
      <button type="submit" style="padding:12px 18px">Confirm unsubscribe</button>
    </form>
  </body>
</html>`);
  } catch {
    return res.status(500).send("Unable to process this request.");
  }
});

unsubscribeRouter.post("/", async (req, res) => {
  const token = unsubscribeToken(req);
  if (!token) return res.status(400).send("Missing or invalid token.");

  try {
    const row = await db("unsubscribe_tokens").where({ token }).first();
    if (!row) return res.status(404).send("Invalid token.");

    await addSuppression({
      userId: row.user_id,
      channel: "email",
      destination: row.destination,
      reason: "unsubscribe",
    });
    await addReferralDestinationSuppression({
      destination: row.destination,
      reason: "unsubscribe",
    });

    return res
      .status(200)
      .send(
        "You are unsubscribed from SendForge Rewards referral invitations."
      );
  } catch {
    return res.status(500).send("Unable to process this request.");
  }
});
