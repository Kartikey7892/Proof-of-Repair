/** Apply pending schema migrations.  Usage: npm run db:migrate */
import { config } from "../src/config.js";
import { openDb } from "../src/db/index.js";

// openDb() runs migrations on connect.
const db = await openDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir });
const { rows } = await db.query("SELECT version, name, applied_at FROM schema_migrations ORDER BY version");
console.log(`[migrate] ${db.label}`);
console.table(rows);
await db.close();
