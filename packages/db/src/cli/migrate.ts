import { loadDatabaseConfig } from '../config';
import { migrateDatabase } from '../migrate';

// pnpm --filter @shotx/db migrate   (DATABASE_URL, or PGHOST/PGDATABASE/PGUSER/PGSSLMODE)
const config = loadDatabaseConfig(process.env);
await migrateDatabase(config);
console.log(`Migrations applied to ${config.database} on ${config.host}`);
