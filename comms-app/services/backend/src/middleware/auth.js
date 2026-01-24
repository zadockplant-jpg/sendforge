import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = payload; // { sub: userId, email }
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}
