import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "../config/redis.js";
import { sendOneProcessor } from "./processors/sendOne.js";

new Worker("send", sendOneProcessor, { connection: redis });

console.log("[worker] running");
