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
  if (!limits) return null;
  return (
    <section className="detail-section">
      <h3>
        KYC Tier Limits
        <span className="read-only-tag">Enforced on mobile</span>
      </h3>
      <p className="muted small" style={{ marginBottom: 12 }}>
        Tier {limits.tierLevel} — {limits.tierName}. Limits reset by UTC calendar day/week/month.
      </p>
      <LimitBar label="Daily" used={limits.daily.usedUSD} limit={limits.daily.limitUSD} remaining={limits.daily.remainingUSD} />
      <LimitBar label="Weekly" used={limits.weekly.usedUSD} limit={limits.weekly.limitUSD} remaining={limits.weekly.remainingUSD} />
      <LimitBar label="Monthly" used={limits.monthly.usedUSD} limit={limits.monthly.limitUSD} remaining={limits.monthly.remainingUSD} />
    </section>
  );
}
