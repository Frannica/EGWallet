import React, { useState } from 'react';
import { hasPermission } from '../api';
import { copyText } from '../utils/ui';

export default function KycDocumentViewer({ blobUrl, documentId, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const canDownload = hasPermission('kyc:download');

  async function handleDownload() {
    const { downloadKycDocument } = await import('../api');
    await downloadKycDocument(documentId);
  }

  return (
    <div className="kyc-viewer">
      <div className="kyc-viewer-toolbar">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setZoom((z) => Math.min(z + 0.25, 3))}>Zoom +</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}>Zoom −</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRotation((r) => r + 90)}>Rotate</button>
        {canDownload && (
          <button type="button" className="btn btn-primary btn-sm" onClick={handleDownload}>Download original</button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyText(documentId, 'Document ID')}>Copy doc ID</button>
        {onClose && <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>}
      </div>
      <div className="kyc-viewer-stage">
        <img
          src={blobUrl}
          alt="KYC document"
          style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
    </div>
  );
}
