import { getActivePlan, getUsage } from "./entitlement.service.js";

export async function checkCanSend({ userId, channel, intendedCount }) {
  const { plan, limits } = await getActivePlan(userId);
  const period = new Date();
  const used = await getUsage(userId, channel);

  const limit = limits[channel] ?? 0;
  const remaining = Math.max(0, limit - used);

  const ok = intendedCount <= remaining;
  return {
    ok,
    plan,
    used,
    limit,
    remaining,
    intendedCount,
    reason: ok ? "" : "over_limit",
  };
}
