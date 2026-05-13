// middleware/audit.js — write-only audit trail for auth events and data mutations
// Never logs request/response bodies — only who did what and when.

const supabase = require('../supabase');

/**
 * Log an audit event. Fire-and-forget — never blocks the main request.
 *
 * @param {string}  userId       req.userId (may be null for pre-auth events)
 * @param {string}  action       e.g. 'task.created', 'email.token_stored'
 * @param {object}  [opts]
 * @param {string}  [opts.resourceType]  e.g. 'task', 'email_account'
 * @param {string}  [opts.resourceId]    primary key of affected row
 * @param {object}  [opts.meta]          small safe metadata (no secrets)
 * @param {object}  [opts.req]           Express request (for IP + UA)
 */
async function audit(userId, action, opts = {}) {
  const { resourceType, resourceId, meta, req } = opts;
  try {
    await supabase.from('audit_log').insert({
      user_id:       userId || null,
      action,
      resource_type: resourceType || null,
      resource_id:   resourceId   ? String(resourceId) : null,
      ip_address:    req?.ip      || null,
      user_agent:    req?.headers?.['user-agent'] || null,
      metadata:      meta && Object.keys(meta).length ? meta : null,
    });
  } catch (err) {
    // Audit failure must never break the main flow
    console.error(`[Audit] Failed to log "${action}":`, err.message);
  }
}

module.exports = { audit };
