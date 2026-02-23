/**
 * Canonical user id resolver.
 * Dev fallbacks removed (no more "dev-user" / fake UUID).
 */
export function getUserId(req) {
  if (req.user?.sub) return String(req.user.sub);
  return null;
}