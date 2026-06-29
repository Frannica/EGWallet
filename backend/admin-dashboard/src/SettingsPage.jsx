import React, { useState, useEffect } from 'react';
import { fetchSettings, updateSettings, hasPermission } from './api';

export default function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [dailySpend, setDailySpend] = useState('');
  const canWrite = hasPermission('settings:write');

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchSettings();
        setSettings(data.settings);
        const mm = data.settings?.maintenance_mode?.value;
        setMaintenanceEnabled(!!mm?.enabled);
        setMaintenanceMessage(mm?.message || '');
        setDailySpend(String(data.settings?.daily_limits?.value?.defaultDailySpendMinor ?? ''));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    try {
      await updateSettings({
        maintenanceMode: { enabled: maintenanceEnabled, message: maintenanceMessage },
        dailyLimits: { defaultDailySpendMinor: Number(dailySpend) || 500000 },
      });
      setSuccess('Settings saved.');
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <p className="muted">Loading settings…</p>;

  return (
    <div>
      <h2 className="page-title">Settings</h2>
      {!canWrite && <p className="muted">Read-only — Super Admin required to edit.</p>}
      {error && <p className="error-text">{error}</p>}
      {success && <p className="success-text">{success}</p>}

      <form onSubmit={handleSave} className="settings-form">
        <section className="detail-section">
          <h3>Maintenance Mode</h3>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={maintenanceEnabled}
              onChange={(e) => setMaintenanceEnabled(e.target.checked)}
              disabled={!canWrite}
            />
            Enable maintenance mode (blocks mobile API)
          </label>
          <label className="form-label">Message</label>
          <input
            className="form-input"
            value={maintenanceMessage}
            onChange={(e) => setMaintenanceMessage(e.target.value)}
            disabled={!canWrite}
          />
        </section>

        <section className="detail-section">
          <h3>Daily Limits</h3>
          <label className="form-label">Default daily spend (minor units)</label>
          <input
            type="number"
            className="form-input"
            value={dailySpend}
            onChange={(e) => setDailySpend(e.target.value)}
            disabled={!canWrite}
          />
        </section>

        {canWrite && (
          <button type="submit" className="btn btn-primary">Save Settings</button>
        )}
      </form>
    </div>
  );
}
