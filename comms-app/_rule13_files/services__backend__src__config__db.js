import knex from "knex";
import { env } from "./env.js";

export const db = knex({ client: "pg", connection: env.databaseUrl });
