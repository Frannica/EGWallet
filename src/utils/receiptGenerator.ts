import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import { formatMinorAmount } from './currency';

export interface Transaction {
  id: string;
  type: 'sent' | 'received';
  amount: number;
  currency: string;
  status: string;
  timestamp: number | string;
  memo?: string;
  wasConverted?: boolean;
  receivedAmount?: number;
  receivedCurrency?: string;
  fromWalletId?: string;
  toWalletId?: string;
}

type Translator = (key: string) => string;

const fallbackEn: Record<string, string> = {
  'common.error': 'Error',
  'receiptPdf.shareSuccessTitle': 'Success',
  'receiptPdf.shareUnavailable': 'Receipt generated but sharing is not available on this device',
  'receiptPdf.generateFailed': 'Failed to generate receipt. Please try again.',
  'receiptPdf.title': 'Transaction Receipt',
  'receiptPdf.conversion': 'Conversion',
  'receiptPdf.received': 'Received',
  'receiptPdf.transactionDetails': 'Transaction Details',
  'receiptPdf.transactionId': 'Transaction ID',
  'receiptPdf.type': 'Type',
  'txHistory.moneyReceived': 'Money Received',
  'txHistory.moneySent': 'Money Sent',
  'receiptPdf.date': 'Date',
  'receiptPdf.time': 'Time',
  'receiptPdf.memo': 'Memo',
  'receiptPdf.account': 'Account',
  'receiptPdf.email': 'Email',
  'receiptPdf.footerTagline': 'Your trusted digital wallet',
  'receiptPdf.generatedOn': 'This receipt was generated on {{date}}',
  'status.completed': 'COMPLETED',
  'status.pending': 'PENDING',
  'status.failed': 'FAILED',
  'status.unknown': 'UNKNOWN',
};

function tOrFallback(t: Translator | undefined, key: string): string {
  if (t) return t(key);
  return fallbackEn[key] ?? key;
}

export async function generateAndShareReceipt(transaction: Transaction, userEmail: string, t?: Translator) {
  try {
    const html = generateReceiptHTML(transaction, userEmail, t);
    
    const { uri } = await Print.printToFileAsync({
      html,
      base64: false,
    });

    // Check if sharing is available
    const isSharingAvailable = await Sharing.isAvailableAsync();
    
    if (isSharingAvailable) {
      await Sharing.shareAsync(uri, {
        UTI: 'application/pdf',
        mimeType: 'application/pdf',
      });
    } else {
      Alert.alert(tOrFallback(t, 'receiptPdf.shareSuccessTitle'), tOrFallback(t, 'receiptPdf.shareUnavailable'));
    }
  } catch (error: any) {
    console.error('Receipt generation failed:', error);
    Alert.alert(tOrFallback(t, 'common.error'), tOrFallback(t, 'receiptPdf.generateFailed'));
  }
}

function generateReceiptHTML(transaction: Transaction, userEmail: string, t?: Translator): string {
  const tr = (key: string) => tOrFallback(t, key);
  const date = new Date(transaction.timestamp);
  const formattedDate = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const formattedTime = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const amountDisplay = formatMinorAmount(transaction.amount, transaction.currency);
  const statusColor = transaction.status === 'completed' ? '#2E7D32' : transaction.status === 'pending' ? '#F57C00' : '#D32F2F';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            padding: 40px 20px;
            background-color: #f5f5f5;
          }
          .receipt {
            max-width: 600px;
            margin: 0 auto;
            background-color: white;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background: linear-gradient(135deg, #007AFF 0%, #0051D5 100%);
            color: white;
            padding: 30px;
            text-align: center;
          }
          .header h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
          }
          .header p {
            font-size: 14px;
            opacity: 0.9;
          }
          .content {
            padding: 30px;
          }
          .section {
            margin-bottom: 24px;
          }
          .section-title {
            font-size: 12px;
            font-weight: 600;
            color: #657786;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
          }
          .amount-display {
            font-size: 36px;
            font-weight: 700;
            color: #1C1E21;
            margin-bottom: 4px;
          }
          .status-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            background-color: ${statusColor}15;
            color: ${statusColor};
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #E1E8ED;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-size: 14px;
            color: #657786;
          }
          .detail-value {
            font-size: 14px;
            font-weight: 600;
            color: #1C1E21;
            text-align: right;
          }
          .footer {
            background-color: #F5F7FA;
            padding: 20px 30px;
            text-align: center;
            font-size: 12px;
            color: #657786;
          }
          .footer strong {
            color: #1C1E21;
          }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="header">
            <h1>EGWallet</h1>
            <p>${tr('receiptPdf.title')}</p>
          </div>
          
          <div class="content">
            <div class="section">
              <div class="amount-display">
                ${transaction.type === 'received' ? '+' : '-'}${amountDisplay} ${transaction.currency}
              </div>
              <span class="status-badge">${tr(`status.${transaction.status?.toLowerCase() || 'unknown'}`)}</span>
            </div>

            ${transaction.wasConverted && transaction.receivedCurrency ? `
              <div class="section">
                <div class="section-title">${tr('receiptPdf.conversion')}</div>
                <div class="detail-value">
                  ${tr('receiptPdf.received')} ${formatMinorAmount(transaction.receivedAmount!, transaction.receivedCurrency!)} ${transaction.receivedCurrency}
                </div>
              </div>
            ` : ''}

            <div class="section">
              <div class="section-title">${tr('receiptPdf.transactionDetails')}</div>
              
              <div class="detail-row">
                <span class="detail-label">${tr('receiptPdf.transactionId')}</span>
                <span class="detail-value">${transaction.id.substring(0, 16)}...</span>
              </div>
              
              <div class="detail-row">
                <span class="detail-label">${tr('receiptPdf.type')}</span>
                <span class="detail-value">${transaction.type === 'received' ? tr('txHistory.moneyReceived') : tr('txHistory.moneySent')}</span>
              </div>
              
              <div class="detail-row">
                <span class="detail-label">${tr('receiptPdf.date')}</span>
                <span class="detail-value">${formattedDate}</span>
              </div>
              
              <div class="detail-row">
                <span class="detail-label">${tr('receiptPdf.time')}</span>
                <span class="detail-value">${formattedTime}</span>
              </div>

              ${transaction.memo ? `
                <div class="detail-row">
                  <span class="detail-label">${tr('receiptPdf.memo')}</span>
                  <span class="detail-value">${transaction.memo}</span>
                </div>
              ` : ''}
            </div>

            <div class="section">
              <div class="section-title">${tr('receiptPdf.account')}</div>
              <div class="detail-row">
                <span class="detail-label">${tr('receiptPdf.email')}</span>
                <span class="detail-value">${userEmail}</span>
              </div>
            </div>
          </div>

          <div class="footer">
            <p>
              <strong>EGWallet</strong> - ${tr('receiptPdf.footerTagline')}<br>
              ${tr('receiptPdf.generatedOn').replace('{{date}}', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}
            </p>
          </div>
        </div>
      </body>
    </html>
  `;
}

