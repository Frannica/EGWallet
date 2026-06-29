import React, { useState, useEffect } from 'react';

export default function ConfirmDialog() {
  const [state, setState] = useState(null);

  useEffect(() => {
    function onConfirm(e) {
      setState(e.detail);
    }
    window.addEventListener('admin-confirm', onConfirm);
    return () => window.removeEventListener('admin-confirm', onConfirm);
  }, []);

  if (!state) return null;

  function close(result) {
    state.resolve(result);
    setState(null);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{state.title}</h3>
        <p>{state.message}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => close(false)}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={() => close(true)}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
