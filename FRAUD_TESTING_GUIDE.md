# Fraud/Theft Response Testing Guide

## Quick Test Commands

### Test 1: Basic Theft Report (English)
**User Message**: `Someone stole $2,000 from my account`

**Expected Backend Response**:
- ✅ `isFraudTheft: true` detected
- ✅ URGENT ticket created (12h SLA)
- ✅ Security lockdown steps displayed (5 steps)
- ✅ Recent transactions shown (last 5)
- ✅ 3 fraud questions presented
- ✅ Suggestions: "Change password", "View transactions", "Report fraud", "Contact support"

**Frontend Display**:
- 🚨 Orange fraud alert banner with "FRAUD ALERT - URGENT"
- 🔒 Security lockdown steps (5 numbered items)
- 📋 Recent transactions list (clickable)
- 💬 Fraud investigation questions
- 🎫 Ticket #TKT-XXX-YYY displayed

---

### Test 2: Theft Report (Spanish)
**User Message**: `Alguien robó $500 de mi cuenta`

**Expected Response**:
- All responses in Spanish
- Same structure as English
- Translation keys working correctly

**Verify Translation**:
- `fraud_theft_alert` → "Siento mucho que esto haya ocurrido..."
- `security_lockdown_title` → "🔒 PASOS DE SEGURIDAD INMEDIATOS:"
- `fraud_q1` → "¿Qué transacción parece no autorizada?"

---

### Test 3: Account Takeover Keywords
**User Message**: `I can't login, someone changed my password`

**Expected Response**:
- ✅ `escalate: true` (account_security category)
- ✅ URGENT ticket created
- ✅ Account recovery steps
- ✅ Security email contact provided

---

### Test 4: Multiple Fraud Variations
Test all these variations to ensure keyword detection:

```
✅ "Someone stole money from my account"
✅ "Money taken without my permission"
✅ "I didn't authorize this transaction"
✅ "I didn't make this purchase"
✅ "This transaction is not me"
✅ "Fraudulent transaction on my account"
✅ "I'm locked out of my account"
✅ "Unknown device logged into my account"
✅ "Strange login attempt detected"
```

All should trigger `isFraudTheft: true` or account security escalation.

---

### Test 5: Multi-Language Support
Test same fraud message in all 8 languages:

| Language | Test Message | Expected Outcome |
|----------|--------------|------------------|
| 🇺🇸 EN | "Someone stole $500 from my account" | English response with lockdown steps |
| 🇪🇸 ES | "Alguien robó $500 de mi cuenta" | Spanish response with "PASOS DE SEGURIDAD" |
| 🇫🇷 FR | "Quelqu'un a volé $500 de mon compte" | French response with "ÉTAPES DE SÉCURITÉ" |
| 🇧🇷 PT | "Alguém roubou $500 da minha conta" | Portuguese response with "PASSOS DE SEGURANÇA" |
| 🇨🇳 ZH | "有人从我的账户中偷走了500美元" | Chinese response with "立即安全步骤" |
| 🇯🇵 JA | "誰かが私のアカウントから500ドルを盗んだ" | Japanese response with "緊急セキュリティ手順" |
| 🇷🇺 RU | "Кто-то украл $500 с моего счета" | Russian response with "НЕМЕДЛЕННЫЕ МЕРЫ" |
| 🇩🇪 DE | "Jemand hat $500 von meinem Konto gestohlen" | German response with "SOFORTIGE SICHERHEITSMASSNAHMEN" |

---

## Backend Testing (curl)

### Start Backend Server
```bash
cd backend
node index.js
```

### Test Fraud Detection Endpoint
```bash
curl -X POST http://localhost:5001/ai/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TEST_TOKEN" \
  -d '{
    "message": "Someone stole $2,000 from my account",
    "language": "en"
  }'
```

**Expected Response**:
```json
{
  "response": "I'm really sorry that happened — this could be an unauthorized transaction. I've created an urgent security case now (Ticket #TKT-XXX-YYY).\n\n🔒 IMMEDIATE SECURITY STEPS:\n1. Change your password NOW\n2. Enable two-factor authentication\n3. Logout all devices\n4. Contact your bank if you linked a card\n5. NEVER share OTP or verification codes\n\n...",
  "suggestions": ["Change password", "View transactions", "Report fraud", "Contact support"],
  "ticketCreated": {
    "ticketId": "TKT-XXX-YYY",
    "priority": "urgent",
    "sla": "12 hours",
    "escalated": true,
    "isFraudAlert": true
  },
  "recentTransactions": [
    {
      "id": "TX-***ABC",
      "fullId": "TX-1234567890ABC",
      "amount": -2000,
      "type": "send",
      "status": "pending",
      "timestamp": 1234567890000,
      "recipient": "u***r@e***.com"
    }
  ],
  "fraudQuestions": [
    {
      "id": "q1",
      "question": "Which transaction looks unauthorized?",
      "type": "transaction_select"
    },
    {
      "id": "q2",
      "question": "Approximate date/time?",
      "type": "datetime"
    },
    {
      "id": "q3",
      "question": "Did you lose your phone or receive suspicious OTP prompts?",
      "type": "yes_no"
    }
  ]
}
```

---

## Frontend Testing (React Native)

### 1. Start Metro Bundler
```bash
npm start
```

### 2. Run on Simulator/Device
```bash
# iOS
npx expo start --ios

# Android
npx expo start --android

# Web (for quick testing)
npx expo start --web
```

### 3. Navigate to AI Support Chat
1. Open app
2. Click "AI Support" or navigate to AIChatScreen
3. Select language (e.g., 🇺🇸 English)
4. Type: "Someone stole $2,000 from my account"
5. Press Send

### 4. Verify UI Elements

**Fraud Alert Banner**:
- [ ] Orange background (`#FFF3E0`)
- [ ] Warning icon (⚠️)
- [ ] "🚨 FRAUD ALERT - URGENT" title
- [ ] Ticket number visible
- [ ] SLA "12 hours" displayed
- [ ] Priority "URGENT" shown

**Security Lockdown Steps**:
- [ ] 5 numbered steps displayed
- [ ] Each step has clear action (Change password, Enable 2FA, etc.)
- [ ] Formatting correct (numbered list)

**Recent Transactions**:
- [ ] Transaction list visible
- [ ] Status icons: ⏳ (pending), ✓ (completed), ✗ (failed)
- [ ] Amount with +/- indicator
- [ ] Transaction ID masked (TX-***ABC)
- [ ] Clickable (tap to report as unauthorized)
- [ ] Date displayed

**Suggestions**:
- [ ] "Change password" chip
- [ ] "View transactions" chip
- [ ] "Report fraud" chip
- [ ] "Contact support" chip
- [ ] Chips clickable and trigger messages

---

## Database Verification

### Check Created Ticket
```bash
# Open backend/db.json
cat backend/db.json | jq '.supportTickets[-1]'
```

**Expected Ticket Structure**:
```json
{
  "id": "TKT-XXX-YYY",
  "userId": "user123",
  "subject": "Auto-escalated: fraud_security",
  "description": "Someone stole $2,000 from my account",
  "category": "fraud_security",
  "priority": "urgent",
  "status": "open",
  "sla": "12 hours",
  "escalated": true,
  "sentiment": "urgent",
  "tags": [
    "auto-escalated",
    "fraud_security",
    "ai-detected",
    "high-emotion"
  ],
  "createdAt": 1234567890000,
  "updatedAt": 1234567890000
}
```

---

## Edge Cases to Test

### 1. No Recent Transactions
**Scenario**: User has 0 transactions
**Expected**: Fraud response without transaction list

### 2. Multiple Suspicious Transactions
**Scenario**: User has 3+ large sends in last 24h
**Expected**: Additional alert "⚠️ ALERT: Multiple suspicious transactions detected — possible account takeover"

### 3. Pending vs Completed Transaction
**Scenario**: User reports pending transaction
**Expected**: Message "⚠️ This transaction is PENDING — we might stop it"

**Scenario**: User reports completed transaction
**Expected**: Message "This transaction was completed. We'll investigate for possible reversal"

### 4. Language Switch Mid-Conversation
**Test**:
1. Start in English
2. Report fraud: "Someone stole money"
3. Switch to Spanish
4. Continue conversation
**Expected**: All subsequent responses in Spanish

---

## Performance Testing

### Load Test
```bash
# Send 100 fraud messages
for i in {1..100}; do
  curl -X POST http://localhost:5001/ai/chat \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer TEST_TOKEN" \
    -d '{"message": "Someone stole money from my account", "language": "en"}' &
done
```

**Expected**:
- [ ] All 100 tickets created
- [ ] No duplicate ticket IDs
- [ ] Response time < 500ms per request
- [ ] No memory leaks
- [ ] db.json updated correctly

---

## Checklist for Production

### Backend
- [ ] All 8 languages have fraud translations (112 translation keys total)
- [ ] `detectEscalation()` detects theft keywords correctly
- [ ] `isFraudTheft` flag set correctly
- [ ] Fraud response handler shows 5 security steps
- [ ] Recent transactions fetched and masked correctly
- [ ] Multiple suspicious transaction detection works
- [ ] Ticket creation with correct tags and priority
- [ ] No backend errors in console

### Frontend
- [ ] Fraud alert banner displays correctly
- [ ] Transaction list renders with correct icons
- [ ] Transactions clickable to report as unauthorized
- [ ] Language selector works for all 8 languages
- [ ] No TypeScript errors
- [ ] No React Native warnings
- [ ] UI responsive on mobile devices
- [ ] Fraud questions displayed (if implemented)

### Database
- [ ] Support tickets created with correct structure
- [ ] Tags include "auto-escalated", "fraud_security", "ai-detected"
- [ ] Priority set to "urgent"
- [ ] SLA set to "12 hours"
- [ ] Sentiment detected correctly

### Compliance
- [ ] No promises of refunds in responses
- [ ] No promises of reversals
- [ ] No admission of liability
- [ ] Clear SLA expectations provided
- [ ] Security email contact provided
- [ ] Empathetic but professional tone

---

## Troubleshooting

### Issue: Fraud keywords not detected
**Solution**: Check `detectEscalation()` function case-insensitive matching:
```javascript
const lowerMessage = message.toLowerCase();
if (lowerMessage.includes("someone stole") || lowerMessage.includes("money taken")) {
  // Should trigger isFraudTheft: true
}
```

### Issue: Translations showing as keys (e.g., "fraud_theft_alert")
**Solution**: 
1. Check `t()` function is called correctly
2. Verify translation key exists in all 8 language objects
3. Check language parameter passed to `/ai/chat` endpoint

### Issue: Recent transactions not showing
**Solution**:
1. Ensure user has transactions in db.json
2. Check `db.transactions` array exists
3. Verify `recentTransactions` field returned in API response
4. Check frontend `Message` type includes `recentTransactions` field

### Issue: Fraud alert banner not displaying
**Solution**:
1. Check `ticketCreated.isFraudAlert` is true in API response
2. Verify `fraudAlert` style exists in StyleSheet
3. Check conditional rendering: `item.ticketCreated.isFraudAlert && styles.fraudAlert`

---

## Success Criteria

✅ **Backend Tests Pass**:
- Fraud keywords detected: 15+ variations
- All 8 languages return translated responses
- Tickets created with correct priority (urgent)
- Security lockdown steps included in response

✅ **Frontend Tests Pass**:
- Fraud alert banner visible
- Recent transactions list displays
- Transactions clickable
- Language selector works

✅ **User Experience**:
- Response time < 500ms
- Clear, actionable security guidance
- Empathetic tone
- No broken UI elements

✅ **Compliance**:
- No liability promises
- Clear SLA messaging
- Safe language throughout

---

## Next Steps After Testing

1. **QA Sign-Off**: Get manual QA approval
2. **Security Review**: Have security team review fraud response flow
3. **Legal Review**: Ensure compliance-safe language approved by legal
4. **Load Testing**: Test with production-scale traffic
5. **Staging Deployment**: Deploy to staging environment
6. **User Acceptance Testing**: Test with real users (beta group)
7. **Production Deployment**: Deploy to production with feature flag
8. **Monitoring**: Set up alerts for fraud ticket creation volume

---

## Monitoring Recommendations

### Key Metrics to Track
1. **Fraud Detection Rate**: % of "stolen" keywords that trigger `isFraudTheft`
2. **Ticket Creation Rate**: Fraud tickets created per day
3. **Response Time**: Time to create fraud ticket and send response
4. **Language Distribution**: Which languages used most for fraud reports
5. **False Positives**: Non-fraud messages incorrectly escalated
6. **User Actions**: % of users who click "Change password" after fraud alert

### Alerts to Set Up
- Alert if fraud tickets > 100/day (possible fraud wave)
- Alert if response time > 2 seconds
- Alert if backend errors on `/ai/chat` endpoint
- Alert if translation key missing (shows as key instead of text)

---

**Testing Status**: ✅ Ready for QA
**Documentation**: ✅ Complete
**Production Ready**: ✅ Pending QA sign-off
