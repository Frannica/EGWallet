"""
Add all missing i18n keys to translations.ts for:
- DepositScreen hardcoded strings
- SendScreen hardcoded strings
All 7 languages: en, fr, es, pt, ar, zh, ja
"""

import re

with open('src/i18n/translations.ts', encoding='utf-8') as f:
    content = f.read()

# New keys per language. We insert them BEFORE 'wallet.serverError' in each language's new-keys block.
# Structure: list of (key, value) tuples per language

new_keys = {
    'en': [
        ("deposit.free", "Free"),
        ("deposit.freeTopupsSingular", "free top-up remaining"),
        ("deposit.freeTopupsPlural", "free top-ups remaining"),
        ("deposit.standardRateApplies", "Standard rate applies"),
        ("deposit.depositAction", "Deposit"),
        ("send.sendInDifferentCurrency", "Send in a different currency"),
        ("send.hideCurrencies", "Hide other currencies"),
        ("send.internationalTransfer", "🌍 International Transfer"),
        ("send.transferFreeInfo", "ℹ️ Transfers are free. A 1.15% FX fee applies only on cross-currency sends."),
        ("send.scamWarningBody", "Only send to people you know and trust."),
        ("send.fxFeeIncluded", "1.15% FX fee included"),
        ("send.fxRateLabel", "Rate"),
        ("send.insufficientBalanceMsg", "You only have {balance} {currency} available.\\n\\nAdd {shortfall} {currency} more to complete this transfer."),
        ("send.insufficientFundsMsg", "You only have {balance} {currency} available."),
    ],
    'fr': [
        ("deposit.free", "Gratuit"),
        ("deposit.freeTopupsSingular", "recharge gratuite restante"),
        ("deposit.freeTopupsPlural", "recharges gratuites restantes"),
        ("deposit.standardRateApplies", "Tarif standard appliqué"),
        ("deposit.depositAction", "Déposer"),
        ("send.sendInDifferentCurrency", "Envoyer dans une autre devise"),
        ("send.hideCurrencies", "Masquer les autres devises"),
        ("send.internationalTransfer", "🌍 Transfert international"),
        ("send.transferFreeInfo", "ℹ️ Les transferts sont gratuits. Des frais FX de 1,15 % s'appliquent uniquement aux envois en devises croisées."),
        ("send.scamWarningBody", "N'envoyez qu'à des personnes que vous connaissez et en qui vous avez confiance."),
        ("send.fxFeeIncluded", "Frais FX de 1,15 % inclus"),
        ("send.fxRateLabel", "Taux"),
        ("send.insufficientBalanceMsg", "Vous n'avez que {balance} {currency} disponible.\\n\\nAjoutez {shortfall} {currency} pour compléter ce transfert."),
        ("send.insufficientFundsMsg", "Vous n'avez que {balance} {currency} disponible."),
    ],
    'es': [
        ("deposit.free", "Gratis"),
        ("deposit.freeTopupsSingular", "recarga gratuita restante"),
        ("deposit.freeTopupsPlural", "recargas gratuitas restantes"),
        ("deposit.standardRateApplies", "Se aplica tarifa estándar"),
        ("deposit.depositAction", "Depositar"),
        ("send.sendInDifferentCurrency", "Enviar en otra divisa"),
        ("send.hideCurrencies", "Ocultar otras divisas"),
        ("send.internationalTransfer", "🌍 Transferencia internacional"),
        ("send.transferFreeInfo", "ℹ️ Las transferencias son gratuitas. Se aplica una comisión FX del 1,15 % solo en envíos con cambio de divisa."),
        ("send.scamWarningBody", "Envía solo a personas que conozcas y en quienes confíes."),
        ("send.fxFeeIncluded", "Comisión FX del 1,15% incluida"),
        ("send.fxRateLabel", "Tasa"),
        ("send.insufficientBalanceMsg", "Solo tienes {balance} {currency} disponible.\\n\\nAgrega {shortfall} {currency} más para completar esta transferencia."),
        ("send.insufficientFundsMsg", "Solo tienes {balance} {currency} disponible."),
    ],
    'pt': [
        ("deposit.free", "Grátis"),
        ("deposit.freeTopupsSingular", "recarga gratuita restante"),
        ("deposit.freeTopupsPlural", "recargas gratuitas restantes"),
        ("deposit.standardRateApplies", "Taxa padrão aplicada"),
        ("deposit.depositAction", "Depositar"),
        ("send.sendInDifferentCurrency", "Enviar em outra moeda"),
        ("send.hideCurrencies", "Ocultar outras moedas"),
        ("send.internationalTransfer", "🌍 Transferência internacional"),
        ("send.transferFreeInfo", "ℹ️ As transferências são gratuitas. Uma taxa FX de 1,15% aplica-se apenas a envios entre moedas diferentes."),
        ("send.scamWarningBody", "Envie apenas para pessoas que você conhece e confia."),
        ("send.fxFeeIncluded", "Taxa FX de 1,15% incluída"),
        ("send.fxRateLabel", "Taxa"),
        ("send.insufficientBalanceMsg", "Você tem apenas {balance} {currency} disponível.\\n\\nAdicione {shortfall} {currency} para concluir esta transferência."),
        ("send.insufficientFundsMsg", "Você tem apenas {balance} {currency} disponível."),
    ],
    'ar': [
        ("deposit.free", "مجاناً"),
        ("deposit.freeTopupsSingular", "شحن مجاني متبقٍ"),
        ("deposit.freeTopupsPlural", "شحنات مجانية متبقية"),
        ("deposit.standardRateApplies", "ينطبق السعر المعياري"),
        ("deposit.depositAction", "إيداع"),
        ("send.sendInDifferentCurrency", "إرسال بعملة مختلفة"),
        ("send.hideCurrencies", "إخفاء العملات الأخرى"),
        ("send.internationalTransfer", "🌍 تحويل دولي"),
        ("send.transferFreeInfo", "ℹ️ التحويلات مجانية. تُطبَّق رسوم تحويل عملة بنسبة 1.15% فقط على الإرسال بعملات مختلفة."),
        ("send.scamWarningBody", "أرسل فقط إلى أشخاص تعرفهم وتثق بهم."),
        ("send.fxFeeIncluded", "رسوم صرف العملة 1.15% مشمولة"),
        ("send.fxRateLabel", "السعر"),
        ("send.insufficientBalanceMsg", "لديك فقط {balance} {currency} متاح.\\n\\nأضف {shortfall} {currency} لإتمام هذا التحويل."),
        ("send.insufficientFundsMsg", "لديك فقط {balance} {currency} متاح."),
    ],
    'zh': [
        ("deposit.free", "免费"),
        ("deposit.freeTopupsSingular", "次免费充值剩余"),
        ("deposit.freeTopupsPlural", "次免费充值剩余"),
        ("deposit.standardRateApplies", "适用标准费率"),
        ("deposit.depositAction", "存入"),
        ("send.sendInDifferentCurrency", "以其他货币发送"),
        ("send.hideCurrencies", "隐藏其他货币"),
        ("send.internationalTransfer", "🌍 国际转账"),
        ("send.transferFreeInfo", "ℹ️ 转账免费。仅跨币种转账时收取1.15%的汇率手续费。"),
        ("send.scamWarningBody", "只向您认识并信任的人转账。"),
        ("send.fxFeeIncluded", "已含1.15%汇率手续费"),
        ("send.fxRateLabel", "汇率"),
        ("send.insufficientBalanceMsg", "您只有 {balance} {currency} 可用。\\n\\n再添加 {shortfall} {currency} 即可完成此转账。"),
        ("send.insufficientFundsMsg", "您只有 {balance} {currency} 可用。"),
    ],
    'ja': [
        ("deposit.free", "無料"),
        ("deposit.freeTopupsSingular", "回の無料チャージ残り"),
        ("deposit.freeTopupsPlural", "回の無料チャージ残り"),
        ("deposit.standardRateApplies", "標準レート適用"),
        ("deposit.depositAction", "入金"),
        ("send.sendInDifferentCurrency", "別の通貨で送金"),
        ("send.hideCurrencies", "他の通貨を隠す"),
        ("send.internationalTransfer", "🌍 国際送金"),
        ("send.transferFreeInfo", "ℹ️ 送金は無料です。異なる通貨間の送金には1.15%のFX手数料が適用されます。"),
        ("send.scamWarningBody", "知っていて信頼できる人にのみ送金してください。"),
        ("send.fxFeeIncluded", "1.15%のFX手数料込み"),
        ("send.fxRateLabel", "レート"),
        ("send.insufficientBalanceMsg", "残高は{balance} {currency}のみです。\\n\\nこの送金を完了するには、さらに{shortfall} {currency}が必要です。"),
        ("send.insufficientFundsMsg", "残高は{balance} {currency}のみです。"),
    ],
}

# The anchor for each language's new-keys block is the 'wallet.serverError' line
# We insert BEFORE that line in each language's section

# We need to find the right wallet.serverError line for each language
# EN wallet.serverError is line 937, FR=1808, ES=2643, PT=3554, AR=4427, ZH=5300, JA=6173
# We use string matching anchored by unique surrounding context

def build_insert_block(lang_keys):
    lines = []
    for key, val in lang_keys:
        lines.append(f"  '{key}': '{val}',")
    return '\n'.join(lines) + '\n'

# We'll identify each insertion point by the unique wallet.serverError value per language
anchor_map = {
    'en': ("  'wallet.serverError': 'Unable to reach the server.',",
           "  'wallet.serverError': 'Unable to reach the server.',"),
    'fr': ("  'wallet.serverError': 'Impossible de joindre le serveur.',",
           "  'wallet.serverError': 'Impossible de joindre le serveur.',"),
    'es': ("  'wallet.serverError': 'No se puede conectar al servidor.',",
           "  'wallet.serverError': 'No se puede conectar al servidor.',"),
    'pt': ("  'wallet.serverError': 'Não foi possível conectar ao servidor.',",
           "  'wallet.serverError': 'Não foi possível conectar ao servidor.',"),
    'ar': ("  'wallet.serverError': 'تعذّر الاتصال بالخادم.',",
           "  'wallet.serverError': 'تعذّر الاتصال بالخادم.',"),
    'zh': ("  'wallet.serverError': '无法连接到服务器。',",
           "  'wallet.serverError': '无法连接到服务器。',"),
    'ja': ("  'wallet.serverError': 'サーバーに接続できません。',",
           "  'wallet.serverError': 'サーバーに接続できません。',"),
}

original = content
for lang, (anchor, _) in anchor_map.items():
    keys = new_keys[lang]
    insert_block = build_insert_block(keys)
    if anchor in content:
        content = content.replace(anchor, insert_block + anchor, 1)
        print(f"[{lang}] Inserted {len(keys)} keys")
    else:
        print(f"[{lang}] WARNING: anchor not found: {anchor[:60]}")

if content != original:
    with open('src/i18n/translations.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("translations.ts updated successfully.")
else:
    print("No changes made.")

# Verify - check all 7 languages have the new keys
verify_key = "deposit.depositAction"
matches = re.findall(f"'{re.escape(verify_key)}'", content)
print(f"\nVerification: '{verify_key}' appears {len(matches)} times (expected 7)")

verify_key2 = "send.scamWarningBody"
matches2 = re.findall(f"'{re.escape(verify_key2)}'", content)
print(f"Verification: '{verify_key2}' appears {len(matches2)} times (expected 7)")
