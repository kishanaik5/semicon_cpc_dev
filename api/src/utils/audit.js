/** Write an audit log row. Accepts a pool or a transaction client. */
export async function audit(db, { entityType, entityId, action, actor = 'system', details = {} }) {
  await db.query(
    `INSERT INTO audit_logs (entity_type, entity_id, action, actor, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId == null ? null : String(entityId), action, actor, JSON.stringify(details)],
  );
}
