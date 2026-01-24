// knexfile.cjs
require("dotenv").config(); // <-- loads .env for knex CLI

module.exports = {
  client: "pg",
  connection: process.env.DATABASE_URL,
  migrations: { directory: "./src/db/migrations" },
};
