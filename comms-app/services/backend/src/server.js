import "dotenv/config";
import { env } from "./config/env.js";
import { app } from "./app.js";
import { ensureDefaultCompCodes } from "./services/compCodes.service.js";

app.listen(env.port, "0.0.0.0", () => {
  console.log(`[api] listening on ${env.port}`);
  // The launch comp code exists as soon as the service is up; no migration needed.
  ensureDefaultCompCodes().catch(() => {});
});
