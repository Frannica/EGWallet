import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatCurrency } from './currency';

export interface Transaction {
  id: string;
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  currency: string;
  fee?: number;
  status: string;
  createdAt: string;
  memo?: string;
}

/**
 * Generate HTML for transaction receipt
 */
function generateReceiptHTML(transaction: Transaction, userEmail?: string): string {
  const date = new Date(transaction.createdAt).toLocaleString();
  const totalAmount = transaction.amount + (transaction.fee || 0);

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Transaction Receipt</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            padding: 32px;
            max-width: 600px;
            margin: 0 auto;
            color: #333;
          }
          .header {
            text-align: center;
            margin-bottom: 32px;
            padding-bottom: 24px;
            border-bottom: 2px solid #007AFF;
          }
          .logo {
            font-size: 32px;
            font-weight: bold;
            color: #007AFF;
            margin-bottom: 8px;
          }
          .subtitle {
            color: #666;
            font-size: 14px;
          }
          .section {
            margin-bottom: 24px;
          }
          .section-title {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
            font-weight: 600;
          }
          .row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #eee;
          }
          .row:last-child {
            border-bottom: none;
          }
          .label {
            color: #666;
            font-size: 14px;
          }
          .value {
            font-weight: 600;
            font-size: 14px;
            text-align: right;
          }
          .total-row {
            background: #f8f8f8;
            padding: 16px;
            margin-top: 16px;
            border-radius: 8px;
          }
          .total-label {
            font-size: 16px;
            color: #333;
            font-weight: 600;
          }
          .total-value {
            font-size: 24px;
            color: #007AFF;
            font-weight: bold;
          }
          .status {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
          }
          .status-completed {
            background: #E8F5E9;
            color: #2E7D32;
          }
          .status-pending {
            background: #FFF3E0;
            color: #F57C00;
          }
          .status-failed {
            background: #FFEBEE;
            color: #C62828;
          }
          .footer {
            margin-top: 48px;
            padding-top: 24px;
            border-top: 1px solid #eee;
            text-align: center;
            color: #999;
            font-size: 12px;
          }
          .transaction-id {
            font-family: 'Courier New', monospace;
            background: #f5f5f5;
            padding: 8px;
            border-radius: 4px;
            font-size: 12px;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">💳 EGWallet</div>
          <div class="subtitle">Transaction Receipt</div>
        </div>

        <div class="section">
          <div class="section-title">Transaction Details</div>
          <div class="row">
            <span class="label">Transaction ID</span>
            <span class="value transaction-id">${transaction.id}</span>
          </div>
          <div class="row">
            <span class="label">Date & Time</span>
            <span class="value">${date}</span>
          </div>
          <div class="row">
            <span class="label">Status</span>
            <span class="value">
              <span class="status status-${transaction.status.toLowerCase()}">${transaction.status}</span>
            </span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Payment Information</div>
          <div class="row">
            <span class="label">From Wallet</span>
            <span class="value">${transaction.fromWalletId}</span>
          </div>
          <div class="row">
            <span class="label">To Wallet</span>
            <span class="value">${transaction.toWalletId}</span>
          </div>
          ${transaction.memo ? `
          <div class="row">
            <span class="label">Memo</span>
            <span class="value">${transaction.memo}</span>
          </div>
          ` : ''}
        </div>

        <div class="section">
          <div class="section-title">Amount Breakdown</div>
          <div class="row">
            <span class="label">Amount</span>
            <span class="value">${transaction.amount.toFixed(2)} ${transaction.currency}</span>
          </div>
          ${transaction.fee ? `
          <div class="row">
            <span class="label">Transaction Fee</span>
            <span class="value">${transaction.fee.toFixed(2)} ${transaction.currency}</span>
          </div>
          ` : ''}
          <div class="row total-row">
            <span class="total-label">Total Amount</span>
            <span class="total-value">${totalAmount.toFixed(2)} ${transaction.currency}</span>
          </div>
        </div>

        <div class="footer">
          <p>This is an official transaction receipt from EGWallet</p>
          ${userEmail ? `<p style="margin-top: 8px;">Account: ${userEmail}</p>` : ''}
          <p style="margin-top: 16px;">For support, contact support@egwallet.com</p>
        </div>
      </body>
    </html>
  `;
}

/**
 * Generate and share transaction receipt PDF
 */
export async function generateAndShareReceipt(
  transaction: Transaction,
  userEmail?: string
): Promise<void> {
  try {
    const html = generateReceiptHTML(transaction, userEmail);
    
    const { uri } = await Print.printToFileAsync({
      html,
      base64: false,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Share Transaction Receipt',
        UTI: 'com.adobe.pdf',
      });
    } else {
      console.warn('Sharing is not available on this device');
    }
  } catch (e) {
    console.error('Failed to generate receipt', e);
    throw new Error('Failed to generate receipt');
  }
}

/**
 * Print transaction receipt
 */
export async function printReceipt(
  transaction: Transaction,
  userEmail?: string
): Promise<void> {
  try {
    const html = generateReceiptHTML(transaction, userEmail);
    await Print.printAsync({ html });
  } catch (e) {
    console.error('Failed to print receipt', e);
    throw new Error('Failed to print receipt');
  }
}
