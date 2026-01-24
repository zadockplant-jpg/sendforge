import IORedis from "ioredis";
import { env } from "./env.js";

export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
