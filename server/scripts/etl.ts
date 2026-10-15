/** Load data/raw datasets into PostgreSQL.  Usage: npm run etl [-- --force] */
import { ROOT, config } from "../src/config.js";
import { runEtl } from "../src/analytics/etl.js";
import { openDb } from "../src/db/index.js";

const db = await openDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir });
console.log(`[etl] database: ${db.label}`);
const report = await runEtl(db, ROOT, { force: process.argv.includes("--force"), log: console.log });
console.table(report);
await db.close();
