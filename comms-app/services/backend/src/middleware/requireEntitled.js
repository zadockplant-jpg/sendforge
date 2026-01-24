import { getActivePlan } from "../services/entitlement.service.js";

export async function requirePaid(req, res, next) {
  const userId = req.user?.sub;
  const { plan } = await getActivePlan(userId);
  if (plan === "free") return res.status(402).json({ error: "payment_required" });
  next();
}
