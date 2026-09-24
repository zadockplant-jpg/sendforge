import { db } from "../../config/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { getRtsConfig } from "./config.js";
import { createHub } from "./events.js";
import { sharedLicenseCache } from "./license.js";
import { createRtsRouter } from "./router.js";
import { createRtsService } from "./service.js";

// Knex opens no connection until the first query, and every route answers 503
// until RTS_ENABLED=true, so mounting this module changes nothing on its own.
const hub = createHub();

export const rtsRouter = createRtsRouter({
  getConfig: getRtsConfig,
  requireAuth,
  db,
  hub,
  licenseCache: sharedLicenseCache,
  service: createRtsService({ db, hub }),
});
