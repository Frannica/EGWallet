const listeners = new Set();

export function subscribeToasts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function showToast(message, type = 'info') {
  listeners.forEach((fn) => fn({ message, type, id: Date.now() }));
}

export function confirmAction(message, title = 'Confirm') {
  return new Promise((resolve) => {
    const event = new CustomEvent('admin-confirm', {
      detail: { title, message, resolve },
    });
    window.dispatchEvent(event);
  });
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied to clipboard`, 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
}

export const INACTIVITY_MS = parseInt(import.meta.env.VITE_ADMIN_INACTIVITY_MS || '1800000', 10);
