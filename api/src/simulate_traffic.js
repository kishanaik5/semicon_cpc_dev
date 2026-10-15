import { pool } from './db.js';
import { generateTraffic } from './services/trafficSimulator.js';

console.log('[simulator] generating realistic demo traffic and validation attempts...');
try {
  const res = await generateTraffic(pool);
  console.log('[simulator] done! Results:', res);
} catch (e) {
  console.error('[simulator] failed:', e);
} finally {
  await pool.end();
}
