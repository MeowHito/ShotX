import { createDb, createPool } from '../client';
import { loadDatabaseConfig } from '../config';
import { seedPlans } from '../seed';

// pnpm --filter @shotx/db seed   (after migrate; never overwrites existing plans)
const pool = createPool(loadDatabaseConfig(process.env));
try {
  const inserted = await seedPlans(createDb(pool));
  console.log(
    inserted.length > 0 ? `Seeded plans: ${inserted.join(', ')}` : 'Plans already seeded',
  );
} finally {
  await pool.end();
}
