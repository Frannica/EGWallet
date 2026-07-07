import React from 'react';

function LimitBar({ label, used, limit, remaining }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="limit-row">
      <div className="limit-row-header">
        <span>{label}</span>
        <span className="mono">${used.toLocaleString()} / ${limit.toLocaleString()} USD</span>
      </div>
      <div className="limit-bar-track">
        <div className="limit-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">Remaining: ${remaining.toLocaleString()} USD</div>
    </div>
  );
}

export default function UserLimitsPanel({ limits }) {
  if (!limits?.daily || !limits?.weekly || !limits?.monthly) return null;
  return (
    <section className="detail-section">
      <h3>
        KYC Send Limits
        <span className="read-only-tag">Send / pay / exchange only</span>
      </h3>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Tier {limits.tierLevel} — {limits.tierName}. Send limits reset by UTC calendar day/week/month.
        Withdrawals are not subject to these caps.
      </p>
      <LimitBar label="Daily send" used={limits.daily.usedUSD} limit={limits.daily.limitUSD} remaining={limits.daily.remainingUSD} />
      <LimitBar label="Weekly send" used={limits.weekly.usedUSD} limit={limits.weekly.limitUSD} remaining={limits.weekly.remainingUSD} />
      <LimitBar label="Monthly send" used={limits.monthly.usedUSD} limit={limits.monthly.limitUSD} remaining={limits.monthly.remainingUSD} />
    </section>
  );
}
