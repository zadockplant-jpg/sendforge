/**
 * Temporary MVP helper.
 * Later this will come from auth middleware / JWT.
 */
export function getUserId(req) {
  // Priority order:
  // 1) Explicit user_id in body (internal calls, tests)
  // 2) Header (future auth)
  // 3) Fallback dev user
  return (
    req.user?.id ||
    req.body?.userId ||
    req.headers["x-user-id"] ||
    "00000000-0000-0000-0000-000000000001"
  );
}
