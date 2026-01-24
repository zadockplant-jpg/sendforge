export function getUserId(req) {
  // Preferred: real auth middleware sets req.user.id
  if (req.user?.id) return req.user.id;

  // Dev fallback: send from Postman / Flutter while auth isn’t wired
  const hdr = req.headers["x-user-id"];
  if (hdr) return String(hdr);

  return null;
}
