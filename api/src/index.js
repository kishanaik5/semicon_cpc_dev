import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { waitForDb, pool } from './db.js';
import { migrate } from './migrate.js';
import { seedIfEmpty } from './seed.js';
import { requireAdmin } from './middleware/auth.js';
import { apiLimiter, couponLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startExpiryJob } from './jobs/expiry.js';
import offersRouter from './routes/offers.js';
import couponsRouter from './routes/coupons.js';
import programsRouter from './routes/programs.js';
import usersRouter from './routes/users.js';
import checkoutRouter from './routes/checkout.js';
import analyticsRouter from './routes/analytics.js';
import auditRouter from './routes/audit.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(apiLimiter);

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: 'up' }); }
  catch { res.status(503).json({ ok: false, db: 'down' }); }
});

// Public (customer-facing)
app.use('/api/checkout', couponLimiter, checkoutRouter);
app.use('/api/users', usersRouter);
app.get('/api/offers/public', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, description, benefit_type, value, max_discount, min_order_amount FROM offers WHERE is_active ORDER BY id`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Admin (PF Admin)
app.use('/api/admin/offers', requireAdmin, offersRouter);
app.use('/api/admin/coupons', requireAdmin, couponsRouter);
app.use('/api/admin/programs', requireAdmin, programsRouter);
app.use('/api/admin/analytics', requireAdmin, analyticsRouter);
app.use('/api/admin/audit', requireAdmin, auditRouter);
app.get('/api/admin/ping', requireAdmin, (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } }));
app.use(errorHandler);

(async () => {
  await waitForDb();
  await migrate();
  if (config.seedDemoData) await seedIfEmpty();
  startExpiryJob();
  app.listen(config.port, () => console.log(`[api] SemiconLabs coupon API listening on :${config.port}`));
})().catch((err) => { console.error(err); process.exit(1); });
