// engine/briefingEmail.js — HTML email template for daily briefing

function urgencyColor(score) {
  if (score >= 12) return '#e11d48'; // rose
  if (score >= 8)  return '#d97706'; // amber
  return '#4361ee';                  // indigo
}

function urgencyDot(score) {
  const c = urgencyColor(score);
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:7px;flex-shrink:0;"></span>`;
}

function carryTag(carryDays) {
  if (carryDays === 0) return `<span style="font-size:11px;background:#eef2ff;color:#4361ee;padding:2px 8px;border-radius:99px;font-weight:600;margin-left:8px;">NEW</span>`;
  return `<span style="font-size:11px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-weight:600;margin-left:8px;">${carryDays}d carrying</span>`;
}

function sectionHeader(title) {
  return `
  <tr><td style="padding:20px 0 10px;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#64748b;border-bottom:1.5px solid #e2e8f0;padding-bottom:8px;">${title}</div>
  </td></tr>`;
}

function accountRow(item, accountSignals) {
  const score = item.current_score;
  const color = urgencyColor(score);
  const linkedSignals = accountSignals.filter(s =>
    s.account_id === item.account_id && s.id !== item.id && s.category === 'action'
  );

  const extraSignals = linkedSignals.map(s =>
    `<div style="font-size:12px;color:#64748b;margin-top:4px;padding-left:16px;">· ${s.signal_detail}</div>`
  ).join('');

  const linkedTasks = accountSignals.filter(s =>
    s.account_id === item.account_id && s.category === 'task'
  ).map(s =>
    `<div style="font-size:12px;color:#64748b;margin-top:4px;padding-left:16px;">→ Task: ${s.signal_detail}</div>`
  ).join('');

  return `
  <tr><td style="padding:8px 0;">
    <div style="background:#f8fafc;border:1.5px solid ${color}22;border-left:3px solid ${color};border-radius:8px;padding:14px 16px;">
      <div style="display:flex;align-items:center;margin-bottom:6px;">
        ${urgencyDot(score)}
        <span style="font-weight:700;font-size:14px;color:#0f172a;">${item.account_name}</span>
        ${carryTag(item.carry_days)}
        <span style="margin-left:auto;font-size:11px;font-family:monospace;color:#94a3b8;font-weight:600;">${Math.round(score)}pts</span>
      </div>
      <div style="font-size:13px;color:#475569;padding-left:16px;">${item.signal_detail}</div>
      ${extraSignals}
      ${linkedTasks}
    </div>
  </td></tr>`;
}

function taskRow(item, isOverdue) {
  const borderColor = isOverdue ? '#e11d48' : '#4361ee';
  const label = isOverdue
    ? `<span style="font-size:11px;color:#e11d48;font-weight:600;margin-left:8px;">OVERDUE</span>`
    : `<span style="font-size:11px;color:#4361ee;font-weight:600;margin-left:8px;">TODAY</span>`;

  return `
  <tr><td style="padding:4px 0;">
    <div style="background:#f8fafc;border:1.5px solid ${borderColor}22;border-left:3px solid ${borderColor};border-radius:6px;padding:10px 14px;display:flex;align-items:center;">
      <span style="font-size:13px;color:#334155;">· ${item.signal_detail}</span>
      ${label}
    </div>
  </td></tr>`;
}

function winRow(item) {
  return `
  <tr><td style="padding:4px 0;">
    <div style="font-size:13px;color:#059669;padding:6px 0;">
      ✓ ${item.signal_detail}
    </div>
  </td></tr>`;
}

// ── Main template ─────────────────────────────────────────────────────────────
function buildBriefingEmail({ csm, date, actionItems, overdueItems, dueTodayItems, wins, appUrl }) {
  const greeting = getGreeting();
  const firstName = (csm.full_name || csm.email || 'there').split(' ')[0];
  const dateStr = new Date(date).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  // Deduplicate: only show the top signal per account in the main list
  const seenAccounts = new Set();
  const topAccountItems = [];
  const allAccountSignals = actionItems.filter(i => i.account_id);

  for (const item of actionItems.filter(i => i.category === 'action').sort((a,b) => b.current_score - a.current_score)) {
    if (!seenAccounts.has(item.account_id)) {
      seenAccounts.add(item.account_id);
      topAccountItems.push(item);
    }
  }

  const accountRows   = topAccountItems.map(i => accountRow(i, allAccountSignals)).join('');
  const overdueRows   = overdueItems.map(i => taskRow(i, true)).join('');
  const dueTodayRows  = dueTodayItems.map(i => taskRow(i, false)).join('');
  const winRows       = wins.map(i => winRow(i)).join('');

  const hasAccounts  = topAccountItems.length > 0;
  const hasOverdue   = overdueItems.length > 0;
  const hasDueToday  = dueTodayItems.length > 0;
  const hasWins      = wins.length > 0;
  const allClear     = !hasAccounts && !hasOverdue && !hasDueToday;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse Briefing — ${dateStr}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 32px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-size:22px;font-weight:800;color:white;letter-spacing:-.03em;">Pulse</div>
              <div style="font-size:13px;color:#94a3b8;margin-top:2px;">Daily Briefing · ${dateStr}</div>
            </div>
          </div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:white;padding:28px 32px;border-radius:0 0 12px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0">

            <!-- Greeting -->
            <tr><td style="padding-bottom:20px;">
              <div style="font-size:20px;font-weight:700;color:#0f172a;">${greeting}, ${firstName} 👋</div>
              ${allClear
                ? `<div style="font-size:14px;color:#64748b;margin-top:6px;">Your portfolio is looking healthy today. No urgent items.</div>`
                : `<div style="font-size:14px;color:#64748b;margin-top:6px;">Here's what needs your attention today.</div>`
              }
            </td></tr>

            <!-- Accounts needing attention -->
            ${hasAccounts ? `
              ${sectionHeader(`${topAccountItems.length} account${topAccountItems.length > 1 ? 's' : ''} need${topAccountItems.length === 1 ? 's' : ''} your attention`)}
              ${accountRows}
            ` : ''}

            <!-- Overdue tasks -->
            ${hasOverdue ? `
              ${sectionHeader(`Overdue tasks (${overdueItems.length})`)}
              ${overdueRows}
            ` : ''}

            <!-- Due today -->
            ${hasDueToday ? `
              ${sectionHeader(`Due today (${dueTodayItems.length})`)}
              ${dueTodayRows}
            ` : ''}

            <!-- Wins -->
            ${hasWins ? `
              ${sectionHeader('Wins')}
              ${winRows}
            ` : ''}

            <!-- CTA -->
            <tr><td style="padding-top:28px;text-align:center;">
              <a href="${appUrl}/briefing" style="display:inline-block;background:#4361ee;color:white;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;letter-spacing:-.01em;">View & manage in Pulse →</a>
            </td></tr>

            <!-- Footer -->
            <tr><td style="padding-top:24px;text-align:center;">
              <div style="font-size:11px;color:#94a3b8;">You're receiving this because you enabled daily briefings in Pulse.<br>Manage settings at <a href="${appUrl}/settings" style="color:#4361ee;text-decoration:none;">Pulse Settings</a></div>
            </td></tr>

          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

module.exports = { buildBriefingEmail };
