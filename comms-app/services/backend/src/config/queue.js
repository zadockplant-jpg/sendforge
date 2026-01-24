import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const sendQueue = new Queue("send", { connection: redis });
