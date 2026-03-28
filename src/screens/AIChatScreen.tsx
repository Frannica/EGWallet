import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Localization from 'expo-localization';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';
import { useNetworkStatus } from '../utils/OfflineError';

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'pt', 'zh', 'ja', 'ru', 'de'];

// All UI strings translated per language
const UI: Record<string, Record<string, string>> = {
  en: {
    init_s1: 'Check my transaction', init_s2: 'Report a problem', init_s3: 'Account limits', init_s4: 'How to send money',
    qa_track: 'Track Transaction', qa_track_q: 'Check my latest transaction status',
    qa_issue: 'Report Issue', qa_issue_q: 'I want to report a problem',
    qa_card: 'Virtual Cards', qa_card_q: 'How do I create a virtual card?',
    qa_verify: 'Verify Identity', qa_verify_q: 'Help me verify my identity',
    typing: 'Felisa is typing...',
    fb_send: 'To send money, tap the **Pay** tab at the bottom, then select **Send Money**. Enter the recipient\'s wallet ID, amount, and currency.',
    fb_receive: 'To request money, tap **Pay → Request Money**. Share your wallet ID or QR code with the sender. Funds arrive instantly once sent.',
    fb_card: 'You can create up to 5 virtual cards in the **Card** tab. Virtual cards can be used for online payments. You can freeze/unfreeze them anytime.',
    fb_balance: 'Your wallet balance is shown on the **Wallet** home screen. Pull down to refresh. You can hold multiple currencies.',
    fb_deposit: 'To add money, tap **Add Money** on the Wallet screen. Deposit using a debit card, credit card, or bank transfer.',
    fb_kyc: 'KYC verification is required to unlock higher limits. Go to **Settings → Verify Identity** and upload a valid ID.',
    fb_fee: 'EGWallet fees:\n\n• Add Money: FREE for first 3 top-ups, then 0.5%\n• Send / Receive: FREE\n• FX Conversion (cross-currency): 1.15%\n• Local Withdrawal: 0.8%\n• International Withdrawal: 1.75%\n\nAll fees are shown before you confirm.',
    fb_currency: 'EGWallet supports 50+ currencies including XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES, INR, CNY, JPY, BRL. Set your preferred currency in **Settings**.',
    fb_report: 'To report a problem, go to **Transaction History** and tap **Dispute** next to the transaction, or use this chat to create a support ticket.',
    fb_support: 'Our support team is available 24/7. Email us at **support@egwallet.com** or visit the Help Center in Settings.',
    fb_default: 'I\'m Felisa, your EGWallet assistant. I can help with sending money, managing cards, checking balances, and resolving issues.',
    fb_s_send: 'How do I receive money?', fb_s_receive: 'How do I send money?', fb_s_card: 'How do I freeze a card?',
    fb_s_balance: 'How do I add money?', fb_s_deposit: 'What are the deposit limits?', fb_s_kyc: 'What are the transaction limits?',
    fb_s_fee: 'How do I send money?', fb_s_currency: 'How do I change my currency?', fb_s_report: 'How do I contact support?',
    fb_s_support: 'How do I send money?', fb_s_default: 'Send money',
  },
  es: {
    init_s1: 'Revisar mi transacción', init_s2: 'Reportar un problema', init_s3: 'Límites de cuenta', init_s4: 'Cómo enviar dinero',
    qa_track: 'Rastrear Transacción', qa_track_q: 'Verificar el estado de mi última transacción',
    qa_issue: 'Reportar Problema', qa_issue_q: 'Quiero reportar un problema',
    qa_card: 'Tarjetas Virtuales', qa_card_q: '¿Cómo creo una tarjeta virtual?',
    qa_verify: 'Verificar Identidad', qa_verify_q: 'Ayúdame a verificar mi identidad',
    typing: 'Felisa está escribiendo...',
    fb_send: 'Para enviar dinero, toca la pestaña **Pago** en la parte inferior y selecciona **Enviar Dinero**. Ingresa el ID de billetera, monto y moneda del destinatario.',
    fb_receive: 'Para solicitar dinero, toca **Pago → Solicitar Dinero**. Comparte tu ID de billetera o código QR con el remitente.',
    fb_card: 'Puedes crear hasta 5 tarjetas virtuales en la pestaña **Tarjeta**. Las tarjetas virtuales se pueden usar para pagos en línea. Puedes congelarlas/descongelarlas en cualquier momento.',
    fb_balance: 'Tu saldo de billetera se muestra en la pantalla de inicio de **Billetera**. Desliza hacia abajo para actualizar.',
    fb_deposit: 'Para agregar dinero, toca **Agregar Dinero** en la pantalla de Billetera. Deposita usando tarjeta de débito, crédito o transferencia bancaria.',
    fb_kyc: 'Se requiere verificación KYC para desbloquear límites más altos. Ve a **Configuración → Verificar Identidad** y sube un documento válido.',
    fb_fee: 'Tarifas de EGWallet:\n\n• Agregar dinero: GRATIS las primeras 3 recargas, luego 0.5%\n• Enviar / Recibir: GRATIS\n• Conversión FX: 1.15%\n• Retiro local: 0.8%\n• Retiro internacional: 1.75%\n\nTodas las tarifas se muestran antes de confirmar.',
    fb_currency: 'EGWallet admite 50+ monedas: XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES, INR y más. Configura tu moneda preferida en **Configuración**.',
    fb_report: 'Para reportar un problema, ve a **Historial de Transacciones** y toca **Disputar**, o usa este chat para crear un ticket de soporte.',
    fb_support: 'Nuestro equipo de soporte está disponible 24/7. Envíanos un correo a **support@egwallet.com** o visita el Centro de Ayuda.',
    fb_default: 'Soy Felisa, tu asistente de EGWallet. Puedo ayudarte con envíos de dinero, tarjetas, saldos y resolución de problemas.',
    fb_s_send: '¿Cómo recibo dinero?', fb_s_receive: '¿Cómo envío dinero?', fb_s_card: '¿Cómo congelo una tarjeta?',
    fb_s_balance: '¿Cómo agrego dinero?', fb_s_deposit: '¿Cuáles son los límites de depósito?', fb_s_kyc: '¿Cuáles son los límites de transacción?',
    fb_s_fee: '¿Cómo envío dinero?', fb_s_currency: '¿Cómo cambio mi moneda?', fb_s_report: '¿Cómo contacto soporte?',
    fb_s_support: '¿Cómo envío dinero?', fb_s_default: 'Enviar dinero',
  },
  fr: {
    init_s1: 'Vérifier ma transaction', init_s2: 'Signaler un problème', init_s3: 'Limites du compte', init_s4: 'Comment envoyer de l\'argent',
    qa_track: 'Suivre Transaction', qa_track_q: 'Vérifier le statut de ma dernière transaction',
    qa_issue: 'Signaler Problème', qa_issue_q: 'Je veux signaler un problème',
    qa_card: 'Cartes Virtuelles', qa_card_q: 'Comment créer une carte virtuelle ?',
    qa_verify: 'Vérifier Identité', qa_verify_q: 'Aidez-moi à vérifier mon identité',
    typing: 'Felisa est en train d\'écrire...',
    fb_send: 'Pour envoyer de l\'argent, appuyez sur l\'onglet **Paiement** en bas et sélectionnez **Envoyer de l\'argent**.',
    fb_receive: 'Pour demander de l\'argent, appuyez sur **Paiement → Demander de l\'argent**. Partagez votre ID de portefeuille ou QR code.',
    fb_card: 'Vous pouvez créer jusqu\'à 5 cartes virtuelles dans l\'onglet **Carte**. Vous pouvez les geler/dégeler à tout moment.',
    fb_balance: 'Votre solde est affiché sur l\'écran d\'accueil **Portefeuille**. Tirez vers le bas pour actualiser.',
    fb_deposit: 'Pour ajouter de l\'argent, appuyez sur **Ajouter de l\'argent** sur l\'écran Portefeuille.',
    fb_kyc: 'La vérification KYC est nécessaire pour débloquer des limites plus élevées. Allez dans **Paramètres → Vérifier l\'identité**.',
    fb_fee: 'Frais EGWallet:\n\n• Ajout d\'argent: GRATUIT 3 premières recharges, puis 0,5%\n• Envoi/Réception: GRATUIT\n• Conversion FX: 1,15%\n• Retrait local: 0,8%\n• Retrait international: 1,75%',
    fb_currency: 'EGWallet prend en charge 50+ devises: XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES et plus. Configurez dans **Paramètres**.',
    fb_report: 'Pour signaler un problème, allez dans l\'**Historique des transactions** et appuyez sur **Contester**.',
    fb_support: 'Notre équipe de support est disponible 24/7. Écrivez-nous à **support@egwallet.com**.',
    fb_default: 'Je suis Felisa, votre assistante EGWallet. Je peux vous aider avec les envois d\'argent, les cartes, les soldes et la résolution de problèmes.',
    fb_s_send: 'Comment recevoir de l\'argent ?', fb_s_receive: 'Comment envoyer de l\'argent ?', fb_s_card: 'Comment geler une carte ?',
    fb_s_balance: 'Comment ajouter de l\'argent ?', fb_s_deposit: 'Quelles sont les limites de dépôt ?', fb_s_kyc: 'Quelles sont les limites de transaction ?',
    fb_s_fee: 'Comment envoyer de l\'argent ?', fb_s_currency: 'Comment changer ma devise ?', fb_s_report: 'Comment contacter le support ?',
    fb_s_support: 'Comment envoyer de l\'argent ?', fb_s_default: 'Envoyer de l\'argent',
  },
  pt: {
    init_s1: 'Verificar minha transação', init_s2: 'Reportar um problema', init_s3: 'Limites da conta', init_s4: 'Como enviar dinheiro',
    qa_track: 'Rastrear Transação', qa_track_q: 'Verificar o status da minha última transação',
    qa_issue: 'Reportar Problema', qa_issue_q: 'Quero reportar um problema',
    qa_card: 'Cartões Virtuais', qa_card_q: 'Como crio um cartão virtual?',
    qa_verify: 'Verificar Identidade', qa_verify_q: 'Me ajude a verificar minha identidade',
    typing: 'Felisa está digitando...',
    fb_send: 'Para enviar dinheiro, toque na aba **Pagamento** e selecione **Enviar Dinheiro**. Insira o ID da carteira, valor e moeda do destinatário.',
    fb_receive: 'Para solicitar dinheiro, toque em **Pagamento → Solicitar Dinheiro**. Compartilhe seu ID de carteira ou QR code.',
    fb_card: 'Você pode criar até 5 cartões virtuais na aba **Cartão**. Você pode congelá-los/descongelá-los a qualquer momento.',
    fb_balance: 'Seu saldo é mostrado na tela inicial da **Carteira**. Deslize para baixo para atualizar.',
    fb_deposit: 'Para adicionar dinheiro, toque em **Adicionar Dinheiro** na tela da Carteira.',
    fb_kyc: 'A verificação KYC é necessária para desbloquear limites maiores. Vá em **Configurações → Verificar Identidade**.',
    fb_fee: 'Taxas do EGWallet:\n\n• Adicionar dinheiro: GRÁTIS 3 primeiras recargas, depois 0,5%\n• Enviar/Receber: GRÁTIS\n• Conversão FX: 1,15%\n• Saque local: 0,8%\n• Saque internacional: 1,75%',
    fb_currency: 'EGWallet suporta 50+ moedas: XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES e mais. Configure em **Configurações**.',
    fb_report: 'Para reportar um problema, vá ao **Histórico de Transações** e toque em **Contestar**.',
    fb_support: 'Nossa equipe de suporte está disponível 24/7. Envie um e-mail para **support@egwallet.com**.',
    fb_default: 'Sou a Felisa, sua assistente EGWallet. Posso te ajudar com envio de dinheiro, cartões, saldos e resolução de problemas.',
    fb_s_send: 'Como recebo dinheiro?', fb_s_receive: 'Como envio dinheiro?', fb_s_card: 'Como congelo um cartão?',
    fb_s_balance: 'Como adiciono dinheiro?', fb_s_deposit: 'Quais são os limites de depósito?', fb_s_kyc: 'Quais são os limites de transação?',
    fb_s_fee: 'Como envio dinheiro?', fb_s_currency: 'Como mudo minha moeda?', fb_s_report: 'Como contato o suporte?',
    fb_s_support: 'Como envio dinheiro?', fb_s_default: 'Enviar dinheiro',
  },
  zh: {
    init_s1: '查看我的交易', init_s2: '报告问题', init_s3: '账户限额', init_s4: '如何汇款',
    qa_track: '追踪交易', qa_track_q: '查看我最新的交易状态',
    qa_issue: '报告问题', qa_issue_q: '我想报告一个问题',
    qa_card: '虚拟卡', qa_card_q: '如何创建虚拟卡？',
    qa_verify: '验证身份', qa_verify_q: '帮我验证我的身份',
    typing: 'Felisa 正在输入...',
    fb_send: '要发送资金，请点击底部的**付款**标签，然后选择**发送资金**。输入收款人的钱包ID、金额和货币。',
    fb_receive: '要请求资金，请点击**付款→请求资金**。与发款方分享您的钱包ID或二维码。',
    fb_card: '您可以在**卡片**标签中创建最多5张虚拟卡。虚拟卡可用于在线支付，可随时冻结/解冻。',
    fb_balance: '您的钱包余额显示在**钱包**主屏幕上。下拉刷新余额。',
    fb_deposit: '要添加资金，请点击钱包屏幕上的**充值**。可使用借记卡、信用卡或银行转账存款。',
    fb_kyc: '需要KYC验证才能解锁更高限额。前往**设置→验证身份**并上传有效证件。',
    fb_fee: 'EGWallet费率：\n\n• 充值：前3次免费，之后0.5%\n• 发送/接收：免费\n• 外汇转换：1.15%\n• 本地提款：0.8%\n• 国际提款：1.75%',
    fb_currency: 'EGWallet支持50+种货币：XAF、USD、EUR、GBP、NGN、GHS、ZAR、KES等。在**设置**中配置您的首选货币。',
    fb_report: '要报告问题，请前往**交易历史**，点击交易旁边的**争议**，或在此聊天中创建支持工单。',
    fb_support: '我们的支持团队全天候(24/7)提供服务。发送电子邮件至**support@egwallet.com**。',
    fb_default: '我是Felisa，您的EGWallet助手。我可以帮助您汇款、管理卡片、查询余额和解决问题。',
    fb_s_send: '如何接收资金？', fb_s_receive: '如何发送资金？', fb_s_card: '如何冻结卡片？',
    fb_s_balance: '如何充值？', fb_s_deposit: '存款限额是多少？', fb_s_kyc: '交易限额是多少？',
    fb_s_fee: '如何发送资金？', fb_s_currency: '如何更改货币？', fb_s_report: '如何联系支持？',
    fb_s_support: '如何发送资金？', fb_s_default: '发送资金',
  },
  ja: {
    init_s1: '取引を確認', init_s2: '問題を報告', init_s3: 'アカウントの限度額', init_s4: '送金方法',
    qa_track: '取引を追跡', qa_track_q: '最新の取引状況を確認する',
    qa_issue: '問題を報告', qa_issue_q: '問題を報告したい',
    qa_card: '仮想カード', qa_card_q: '仮想カードを作成するにはどうすればいいですか？',
    qa_verify: '身元確認', qa_verify_q: '身元確認を手伝ってください',
    typing: 'Felisa が入力中...',
    fb_send: '送金するには、下部の**支払い**タブをタップし、**送金**を選択します。受取人のウォレットID、金額、通貨を入力してください。',
    fb_receive: '請求するには、**支払い→送金依頼**をタップします。ウォレットIDまたはQRコードを送り手と共有してください。',
    fb_card: '**カード**タブで最大5枚の仮想カードを作成できます。仮想カードはオンライン支払いに使用でき、いつでも凍結/解除できます。',
    fb_balance: 'ウォレットの残高は**ウォレット**ホーム画面に表示されています。下に引いて更新してください。',
    fb_deposit: 'お金を追加するには、ウォレット画面で**お金を追加**をタップします。',
    fb_kyc: 'より高い限度額を解除するにはKYC確認が必要です。**設定→身元確認**へ移動してください。',
    fb_fee: 'EGWallet手数料：\n\n• 入金：最初の3回無料、以降0.5%\n• 送金/受け取り：無料\n• 外貨両替：1.15%\n• 国内出金：0.8%\n• 国際出金：1.75%',
    fb_currency: 'EGWalletはXAF、USD、EUR、GBP、NGN、GHS、ZAR、KESなど50以上の通貨をサポートしています。',
    fb_report: '問題を報告するには、**取引履歴**に移動して取引の横の**異議申し立て**をタップするか、このチャットでサポートチケットを作成してください。',
    fb_support: 'サポートチームは24時間365日対応しています。**support@egwallet.com**にメールをお送りください。',
    fb_default: '私はFelisa、あなたのEGWalletアシスタントです。送金、カード管理、残高確認、問題解決をお手伝いします。',
    fb_s_send: 'お金を受け取るには？', fb_s_receive: 'お金を送るには？', fb_s_card: 'カードを凍結するには？',
    fb_s_balance: 'お金を追加するには？', fb_s_deposit: '入金限度額は？', fb_s_kyc: '取引限度額は？',
    fb_s_fee: 'お金を送るには？', fb_s_currency: '通貨を変更するには？', fb_s_report: 'サポートに連絡するには？',
    fb_s_support: 'お金を送るには？', fb_s_default: '送金する',
  },
  ru: {
    init_s1: 'Проверить транзакцию', init_s2: 'Сообщить о проблеме', init_s3: 'Лимиты аккаунта', init_s4: 'Как отправить деньги',
    qa_track: 'Отследить транзакцию', qa_track_q: 'Проверить статус последней транзакции',
    qa_issue: 'Сообщить о проблеме', qa_issue_q: 'Хочу сообщить о проблеме',
    qa_card: 'Виртуальные карты', qa_card_q: 'Как создать виртуальную карту?',
    qa_verify: 'Подтвердить личность', qa_verify_q: 'Помогите мне подтвердить личность',
    typing: 'Felisa печатает...',
    fb_send: 'Чтобы отправить деньги, нажмите вкладку **Оплата** внизу и выберите **Отправить деньги**. Введите ID кошелька получателя, сумму и валюту.',
    fb_receive: 'Чтобы запросить деньги, нажмите **Оплата → Запросить деньги**. Поделитесь своим ID кошелька или QR-кодом.',
    fb_card: 'Вы можете создать до 5 виртуальных карт во вкладке **Карта**. Виртуальные карты можно использовать для онлайн-платежей.',
    fb_balance: 'Баланс кошелька отображается на главном экране **Кошелёк**. Потяните вниз для обновления.',
    fb_deposit: 'Чтобы добавить деньги, нажмите **Пополнить** на экране Кошелька.',
    fb_kyc: 'Для разблокировки более высоких лимитов требуется KYC-верификация. Перейдите в **Настройки → Подтвердить личность**.',
    fb_fee: 'Комиссии EGWallet:\n\n• Пополнение: первые 3 — БЕСПЛАТНО, затем 0,5%\n• Отправка/Получение: БЕСПЛАТНО\n• Конвертация валют: 1,15%\n• Вывод внутри страны: 0,8%\n• Международный вывод: 1,75%',
    fb_currency: 'EGWallet поддерживает 50+ валют: XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES и другие.',
    fb_report: 'Чтобы сообщить о проблеме, перейдите в **Историю транзакций** и нажмите **Спор** рядом с транзакцией.',
    fb_support: 'Наша команда поддержки работает круглосуточно. Напишите нам на **support@egwallet.com**.',
    fb_default: 'Я Фелиса, ваш помощник EGWallet. Могу помочь с переводами, картами, балансами и решением проблем.',
    fb_s_send: 'Как получить деньги?', fb_s_receive: 'Как отправить деньги?', fb_s_card: 'Как заморозить карту?',
    fb_s_balance: 'Как добавить деньги?', fb_s_deposit: 'Каковы лимиты депозита?', fb_s_kyc: 'Каковы лимиты транзакций?',
    fb_s_fee: 'Как отправить деньги?', fb_s_currency: 'Как изменить валюту?', fb_s_report: 'Как связаться с поддержкой?',
    fb_s_support: 'Как отправить деньги?', fb_s_default: 'Отправить деньги',
  },
  de: {
    init_s1: 'Meine Transaktion prüfen', init_s2: 'Problem melden', init_s3: 'Kontolimits', init_s4: 'Wie sende ich Geld',
    qa_track: 'Transaktion verfolgen', qa_track_q: 'Status meiner letzten Transaktion prüfen',
    qa_issue: 'Problem melden', qa_issue_q: 'Ich möchte ein Problem melden',
    qa_card: 'Virtuelle Karten', qa_card_q: 'Wie erstelle ich eine virtuelle Karte?',
    qa_verify: 'Identität verifizieren', qa_verify_q: 'Helfen Sie mir, meine Identität zu verifizieren',
    typing: 'Felisa tippt...',
    fb_send: 'Um Geld zu senden, tippen Sie auf den **Zahlungs**-Tab unten und wählen Sie **Geld senden**. Geben Sie die Wallet-ID, den Betrag und die Währung ein.',
    fb_receive: 'Um Geld anzufordern, tippen Sie auf **Zahlung → Geld anfordern**. Teilen Sie Ihre Wallet-ID oder Ihren QR-Code.',
    fb_card: 'Sie können bis zu 5 virtuelle Karten im **Karten**-Tab erstellen. Sie können diese jederzeit einfrieren/entsperren.',
    fb_balance: 'Ihr Wallet-Guthaben wird auf dem **Wallet**-Startbildschirm angezeigt. Nach unten ziehen zum Aktualisieren.',
    fb_deposit: 'Um Geld hinzuzufügen, tippen Sie auf **Geld hinzufügen** auf dem Wallet-Bildschirm.',
    fb_kyc: 'Eine KYC-Verifizierung ist erforderlich, um höhere Limits freizuschalten. Gehen Sie zu **Einstellungen → Identität verifizieren**.',
    fb_fee: 'EGWallet-Gebühren:\n\n• Geld hinzufügen: Erste 3 KOSTENLOS, danach 0,5%\n• Senden/Empfangen: KOSTENLOS\n• FX-Umtausch: 1,15%\n• Inland-Auszahlung: 0,8%\n• Internationale Auszahlung: 1,75%',
    fb_currency: 'EGWallet unterstützt 50+ Währungen: XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES und mehr.',
    fb_report: 'Um ein Problem zu melden, gehen Sie zum **Transaktionsverlauf** und tippen Sie auf **Dispute**, oder nutzen Sie diesen Chat.',
    fb_support: 'Unser Support-Team ist 24/7 verfügbar. Schreiben Sie uns an **support@egwallet.com**.',
    fb_default: 'Ich bin Felisa, Ihr EGWallet-Assistent. Ich kann Ihnen bei Überweisungen, Karten, Guthaben und der Problemlösung helfen.',
    fb_s_send: 'Wie empfange ich Geld?', fb_s_receive: 'Wie sende ich Geld?', fb_s_card: 'Wie friere ich eine Karte ein?',
    fb_s_balance: 'Wie füge ich Geld hinzu?', fb_s_deposit: 'Was sind die Einzahlungslimits?', fb_s_kyc: 'Was sind die Transaktionslimits?',
    fb_s_fee: 'Wie sende ich Geld?', fb_s_currency: 'Wie ändere ich meine Währung?', fb_s_report: 'Wie kontaktiere ich den Support?',
    fb_s_support: 'Wie sende ich Geld?', fb_s_default: 'Geld senden',
  },
};

function uiStr(lang: string, key: string): string {
  return UI[lang]?.[key] ?? UI.en[key] ?? key;
}

function getDeviceLanguage(): string {
  try {
    const locales = Localization.getLocales();
    if (locales && locales.length > 0) {
      const lang = locales[0].languageCode?.toLowerCase() || 'en';
      return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
    }
  } catch {
    // ignore
  }
  return 'en';
}

const INITIAL_GREETINGS: Record<string, string> = {
  en: "Hello! My name is Felisa. How can I help you today?",
  es: "¡Hola! Me llamo Felisa. ¿En qué puedo ayudarte hoy?",
  fr: "Bonjour ! Je m'appelle Felisa. Comment puis-je vous aider aujourd'hui ?",
  pt: "Olá! Meu nome é Felisa. Como posso ajudá-lo hoje?",
  zh: "您好！我叫 Felisa。今天我能帮您什么？",
  ja: "こんにちは！私はFelisaです。本日はどのようにお手伝いできますか？",
  ru: "Здравствуйте! Меня зовут Фелиса. Как я могу помочь вам сегодня?",
  de: "Hallo! Mein Name ist Felisa. Wie kann ich Ihnen heute helfen?",
};

type Message = {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: number;
  suggestions?: string[];
  ticketCreated?: {
    ticketId: string;
    priority: 'urgent' | 'high' | 'normal';
    sla: string;
    escalated?: boolean;
    isFraudAlert?: boolean;
  };
  needsMoreInfo?: {
    fields: Array<{
      name: string;
      label: string;
      type: string;
      required: boolean;
      hint?: string;
    }>;
    reason: string;
  };
  recentTransactions?: Array<{
    id: string;
    fullId: string;
    amount: number;
    type: string;
    status: string;
    timestamp: number;
    recipient?: string;
  }>;
  fraudQuestions?: Array<{
    id: string;
    question: string;
    type: 'transaction_select' | 'datetime' | 'yes_no';
  }>;
};

type QuickAction = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  query: string;
};

export default function AIChatScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const initialLang = getDeviceLanguage();
  const [language, setLanguage] = useState<string>(initialLang);
  const [messages, setMessages] = useState<Message[]>([{
    id: '1',
    text: INITIAL_GREETINGS[initialLang] ?? INITIAL_GREETINGS.en,
    sender: 'ai',
    timestamp: Date.now(),
    suggestions: [
      uiStr(initialLang, 'init_s1'),
      uiStr(initialLang, 'init_s2'),
      uiStr(initialLang, 'init_s3'),
      uiStr(initialLang, 'init_s4'),
    ]
  }]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [structuredDataForm, setStructuredDataForm] = useState<any>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const languages = [
    { code: 'en', flag: '🇺🇸', name: 'English' },
    { code: 'es', flag: '🇪🇸', name: 'Español' },
    { code: 'fr', flag: '🇫🇷', name: 'Français' },
    { code: 'pt', flag: '🇧🇷', name: 'Português' },
    { code: 'zh', flag: '🇨🇳', name: '中文' },
    { code: 'ja', flag: '🇯🇵', name: '日本語' },
    { code: 'ru', flag: '🇷🇺', name: 'Русский' },
    { code: 'de', flag: '🇩🇪', name: 'Deutsch' }
  ];

  const quickActions: QuickAction[] = [
    { id: '1', icon: 'search', label: uiStr(language, 'qa_track'), query: uiStr(language, 'qa_track_q') },
    { id: '2', icon: 'alert-circle', label: uiStr(language, 'qa_issue'), query: uiStr(language, 'qa_issue_q') },
    { id: '3', icon: 'card', label: uiStr(language, 'qa_card'), query: uiStr(language, 'qa_card_q') },
    { id: '4', icon: 'shield-checkmark', label: uiStr(language, 'qa_verify'), query: uiStr(language, 'qa_verify_q') },
  ];

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  async function sendMessage(text: string, structuredData?: Record<string, string>) {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: text.trim(),
      sender: 'user',
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setStructuredDataForm(null); // Clear form
    setFormData({});
    setIsTyping(true);

    try {
      // Skip API when offline — show demo response instantly
      if (!isOnline) throw new Error('Offline — demo mode');

      // Call AI backend with 2-second timeout — demo mode fires instantly on any failure
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let response: Response | null = null;
      try {
        response = await fetch(`${API_BASE}/ai/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            message: text.trim(),
            conversationHistory: messages.slice(-5),
            structuredData: structuredData || null,
            language: language,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response && response.ok) {
        const data = await response.json();
        
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          text: data.response,
          sender: 'ai',
          timestamp: Date.now(),
          suggestions: data.suggestions,
          ticketCreated: data.ticketCreated,
          needsMoreInfo: data.needsMoreInfo,
          recentTransactions: data.recentTransactions,
          fraudQuestions: data.fraudQuestions,
        };

        setMessages(prev => [...prev, aiMessage]);
        
        if (data.needsMoreInfo) {
          setStructuredDataForm(data.needsMoreInfo);
        }
      } else {
        throw new Error('AI unavailable');
      }
    } catch (error: any) {
      // Smart demo fallback with canned responses when AI is unavailable
      const msg = text.trim().toLowerCase();
      let fallbackText = '';
      let fallbackSuggestions: string[] | undefined;
      const L = language;

      if (msg.includes('send') || msg.includes('transfer') || msg.includes('enviar') || msg.includes('envoyer') || msg.includes('senden') || msg.includes('送') || msg.includes('送金')) {
        fallbackText = uiStr(L, 'fb_send');
        fallbackSuggestions = [uiStr(L, 'fb_s_send'), uiStr(L, 'fb_s_currency')];
      } else if (msg.includes('receiv') || msg.includes('request') || msg.includes('recib') || msg.includes('recevoir') || msg.includes('empfang') || msg.includes('接收') || msg.includes('受け取')) {
        fallbackText = uiStr(L, 'fb_receive');
        fallbackSuggestions = [uiStr(L, 'fb_s_receive'), uiStr(L, 'fb_s_send')];
      } else if (msg.includes('card') || msg.includes('virtual') || msg.includes('tarjeta') || msg.includes('carte') || msg.includes('karte') || msg.includes('卡') || msg.includes('カード')) {
        fallbackText = uiStr(L, 'fb_card');
        fallbackSuggestions = [uiStr(L, 'fb_s_card'), uiStr(L, 'fb_s_balance')];
      } else if (msg.includes('balance') || msg.includes('wallet') || msg.includes('saldo') || msg.includes('solde') || msg.includes('guthaben') || msg.includes('余额') || msg.includes('残高')) {
        fallbackText = uiStr(L, 'fb_balance');
        fallbackSuggestions = [uiStr(L, 'fb_s_balance'), uiStr(L, 'fb_s_send')];
      } else if (msg.includes('deposit') || msg.includes('add money') || msg.includes('top up') || msg.includes('agregar') || msg.includes('ajouter') || msg.includes('充值') || msg.includes('入金')) {
        fallbackText = uiStr(L, 'fb_deposit');
        fallbackSuggestions = [uiStr(L, 'fb_s_deposit'), uiStr(L, 'fb_s_send')];
      } else if (msg.includes('kyc') || msg.includes('verify') || msg.includes('identity') || msg.includes('verif') || msg.includes('verificar') || msg.includes('身份') || msg.includes('本人確認')) {
        fallbackText = uiStr(L, 'fb_kyc');
        fallbackSuggestions = [uiStr(L, 'fb_s_kyc'), uiStr(L, 'fb_s_support')];
      } else if (msg.includes('fee') || msg.includes('charge') || msg.includes('cost') || msg.includes('tarifa') || msg.includes('frais') || msg.includes('gebühr') || msg.includes('费') || msg.includes('手数料')) {
        fallbackText = uiStr(L, 'fb_fee');
        fallbackSuggestions = [uiStr(L, 'fb_s_fee'), uiStr(L, 'fb_s_currency')];
      } else if (msg.includes('currency') || msg.includes('currencies') || msg.includes('xaf') || msg.includes('moneda') || msg.includes('devise') || msg.includes('währung') || msg.includes('货币') || msg.includes('通貨')) {
        fallbackText = uiStr(L, 'fb_currency');
        fallbackSuggestions = [uiStr(L, 'fb_s_currency'), uiStr(L, 'fb_s_send')];
      } else if (msg.includes('report') || msg.includes('problem') || msg.includes('issue') || msg.includes('dispute') || msg.includes('problema') || msg.includes('problème') || msg.includes('問題') || msg.includes('проблем')) {
        fallbackText = uiStr(L, 'fb_report');
        fallbackSuggestions = [uiStr(L, 'fb_s_report'), uiStr(L, 'fb_s_card')];
      } else if (msg.includes('support') || msg.includes('help') || msg.includes('contact') || msg.includes('ayuda') || msg.includes('aide') || msg.includes('hilfe') || msg.includes('помощ') || msg.includes('ヘルプ')) {
        fallbackText = uiStr(L, 'fb_support');
        fallbackSuggestions = [uiStr(L, 'fb_s_support'), uiStr(L, 'fb_s_report')];
      } else {
        fallbackText = uiStr(L, 'fb_default');
        fallbackSuggestions = [uiStr(L, 'fb_s_default'), uiStr(L, 'fb_s_balance'), uiStr(L, 'fb_s_card'), uiStr(L, 'fb_s_support')];
      }

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: fallbackText,
        sender: 'ai',
        timestamp: Date.now(),
        suggestions: fallbackSuggestions,
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleQuickAction(action: QuickAction) {
    sendMessage(action.query);
  }

  function handleSuggestion(suggestion: string) {
    sendMessage(suggestion);
  }

  function renderMessage({ item }: { item: Message }) {
    const isUser = item.sender === 'user';

    return (
      <View style={[styles.messageContainer, isUser ? styles.userMessageContainer : styles.aiMessageContainer]}>
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Ionicons name="sparkles" size={16} color="#FFFFFF" />
          </View>
        )}
        
        <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={[styles.messageText, isUser ? styles.userText : styles.aiText]}>
            {item.text}
          </Text>
          
          {/* Support ticket created alert */}
          {item.ticketCreated && (
            <View style={[
              styles.ticketAlert,
              item.ticketCreated.priority === 'urgent' && styles.ticketAlertUrgent,
              item.ticketCreated.isFraudAlert && styles.fraudAlert
            ]}>
              <View style={styles.ticketAlertHeader}>
                <Ionicons 
                  name={item.ticketCreated.isFraudAlert ? "warning" : item.ticketCreated.escalated ? "alert-circle" : "checkmark-circle"} 
                  size={18} 
                  color={item.ticketCreated.isFraudAlert || item.ticketCreated.priority === 'urgent' ? "#FF3B30" : "#34C759"} 
                />
                <Text style={styles.ticketAlertTitle}>
                  {item.ticketCreated.isFraudAlert ? "🚨 FRAUD ALERT - URGENT" : item.ticketCreated.escalated ? "⚡ Escalated Support Ticket" : "✓ Support Ticket Created"}
                </Text>
              </View>
              <Text style={styles.ticketId}>Ticket #{item.ticketCreated.ticketId}</Text>
              <Text style={styles.ticketSLA}>
                Expected response: {item.ticketCreated.sla}
              </Text>
              <Text style={styles.ticketPriority}>
                Priority: {item.ticketCreated.priority.toUpperCase()}
              </Text>
            </View>
          )}
          
          {/* Recent transactions for fraud cases */}
          {item.recentTransactions && item.recentTransactions.length > 0 && (
            <View style={styles.transactionsContainer}>
              <Text style={styles.transactionsTitle}>Recent Transactions:</Text>
              {item.recentTransactions.map((tx, index) => (
                <TouchableOpacity
                  key={tx.fullId}
                  style={styles.transactionItem}
                  onPress={() => {
                    sendMessage(`I want to report transaction ${tx.id} (${tx.type === 'send' ? '-' : '+'}$${Math.abs(tx.amount).toFixed(2)}) as unauthorized.`);
                  }}
                >
                  <View style={styles.transactionRow}>
                    <Ionicons 
                      name={tx.status === 'pending' ? 'time-outline' : tx.status === 'completed' ? 'checkmark-circle' : 'close-circle'} 
                      size={16} 
                      color={tx.status === 'pending' ? '#FF9500' : tx.status === 'completed' ? '#34C759' : '#FF3B30'} 
                    />
                    <Text style={styles.transactionAmount}>
                      {tx.type === 'send' ? '-' : '+'}${Math.abs(tx.amount).toFixed(2)}
                    </Text>
                    <Text style={styles.transactionId}>{tx.id}</Text>
                  </View>
                  <Text style={styles.transactionStatus}>
                    {tx.status.toUpperCase()} • {new Date(tx.timestamp).toLocaleDateString()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          
          {item.suggestions && item.suggestions.length > 0 && (
            <View style={styles.suggestionsContainer}>
              {item.suggestions.map((suggestion, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.suggestionChip}
                  onPress={() => handleSuggestion(suggestion)}
                >
                  <Text style={styles.suggestionText}>{suggestion}</Text>
                  <Ionicons name="chevron-forward" size={14} color="#007AFF" />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {isUser && (
          <View style={styles.userAvatar}>
            <Ionicons name="person" size={16} color="#FFFFFF" />
          </View>
        )}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <View style={styles.aiIcon}>
            <Ionicons name="sparkles" size={24} color="#007AFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Felisa</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#22C55E' }} />
              <Text style={styles.headerSubtitle}>Available 24/7</Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.languageButton}
            onPress={() => setShowLanguageMenu(!showLanguageMenu)}
          >
            <Text style={styles.languageButtonText}>
              {languages.find(l => l.code === language)?.flag} {language.toUpperCase()}
            </Text>
            <Ionicons name="chevron-down" size={16} color="#007AFF" />
          </TouchableOpacity>
        </View>
        
        {/* Language Selector Dropdown */}
        {showLanguageMenu && (
          <View style={styles.languageMenu}>
            {languages.map(lang => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.languageMenuItem,
                  language === lang.code && styles.languageMenuItemActive
                ]}
                onPress={async () => {
                  const newLang = lang.code;
                  setLanguage(newLang);
                  setShowLanguageMenu(false);
                  // Add a new greeting in the selected language
                  if (newLang !== language) {
                    const greetingMsg: Message = {
                      id: Date.now().toString(),
                      text: INITIAL_GREETINGS[newLang] ?? INITIAL_GREETINGS.en,
                      sender: 'ai',
                      timestamp: Date.now(),
                      suggestions: [
                        uiStr(newLang, 'init_s1'),
                        uiStr(newLang, 'init_s2'),
                        uiStr(newLang, 'init_s3'),
                        uiStr(newLang, 'init_s4'),
                      ],
                    };
                    setMessages(prev => [...prev, greetingMsg]);
                  }
                  // Save language preference to backend
                  try {
                    await fetch(`${API_BASE}/user/language`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${auth.token}`,
                      },
                      body: JSON.stringify({ language: newLang }),
                    });
                  } catch (error) {
                    console.log('Failed to save language preference');
                  }
                }}
              >
                <Text style={styles.languageMenuFlag}>{lang.flag}</Text>
                <Text style={[
                  styles.languageMenuText,
                  language === lang.code && styles.languageMenuTextActive
                ]}>
                  {lang.name}
                </Text>
                {language === lang.code && (
                  <Ionicons name="checkmark" size={20} color="#007AFF" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Quick Actions */}
      {messages.length <= 1 && (
        <View style={styles.quickActionsContainer}>
          <Text style={styles.quickActionsTitle}>Quick Actions</Text>
          <View style={styles.quickActionsGrid}>
            {quickActions.map(action => (
              <TouchableOpacity
                key={action.id}
                style={styles.quickActionCard}
                onPress={() => handleQuickAction(action)}
              >
                <Ionicons name={action.icon} size={24} color="#007AFF" />
                <Text style={styles.quickActionLabel}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        showsVerticalScrollIndicator={false}
      />

      {isTyping && (
        <View style={styles.typingIndicator}>
          <View style={styles.typingDot} />
          <View style={styles.typingDot} />
          <View style={styles.typingDot} />
          <Text style={styles.typingText}>{uiStr(language, 'typing')}</Text>
        </View>
      )}

      {/* Structured Data Collection Form */}
      {structuredDataForm && (
        <View style={styles.dataCollectionForm}>
          <View style={styles.formHeader}>
            <Ionicons name="document-text" size={20} color="#007AFF" />
            <Text style={styles.formTitle}>{structuredDataForm.reason}</Text>
          </View>
          
          {structuredDataForm.fields.map((field: any, index: number) => (
            <View key={index} style={styles.formField}>
              <Text style={styles.fieldLabel}>
                {field.label} {field.required && <Text style={styles.required}>*</Text>}
              </Text>
              <TextInput
                style={styles.fieldInput}
                value={formData[field.name] || ''}
                onChangeText={(text) => setFormData(prev => ({ ...prev, [field.name]: text }))}
                placeholder={field.hint || `Enter ${field.label.toLowerCase()}`}
                placeholderTextColor="#AAB8C2"
                keyboardType={field.type === 'number' ? 'numeric' : 'default'}
              />
            </View>
          ))}
          
          <View style={styles.formActions}>
            <TouchableOpacity
              style={styles.formButtonSecondary}
              onPress={() => {
                setStructuredDataForm(null);
                setFormData({});
                sendMessage('Skip data collection and create general ticket');
              }}
            >
              <Text style={styles.formButtonSecondaryText}>Skip</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.formButtonPrimary}
              onPress={() => {
                const requiredFields = structuredDataForm.fields.filter((f: any) => f.required);
                const allFieldsFilled = requiredFields.every((f: any) => formData[f.name]?.trim());
                
                if (!allFieldsFilled) {
                  alert('Please fill in all required fields');
                  return;
                }
                
                sendMessage('Submitting case details', formData);
              }}
            >
              <Text style={styles.formButtonPrimaryText}>Submit Details</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Ask me anything..."
          placeholderTextColor="#AAB8C2"
          multiline
          maxLength={500}
        />
        <TouchableOpacity
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
          onPress={() => sendMessage(inputText)}
          disabled={!inputText.trim() || isTyping}
        >
          <Ionicons name="send" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  header: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F0F7FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1C1E21',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#657786',
    marginTop: 2,
  },
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0F7FF',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    gap: 4,
  },
  languageButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
  },
  languageMenu: {
    marginTop: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E1E8ED',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  languageMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F7FA',
    gap: 12,
  },
  languageMenuItemActive: {
    backgroundColor: '#F0F7FF',
  },
  languageMenuFlag: {
    fontSize: 24,
  },
  languageMenuText: {
    flex: 1,
    fontSize: 15,
    color: '#1C1E21',
  },
  languageMenuTextActive: {
    fontWeight: '600',
    color: '#007AFF',
  },
  quickActionsContainer: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  quickActionsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#657786',
    marginBottom: 12,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickActionCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#F0F7FF',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  quickActionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
    textAlign: 'center',
  },
  messagesList: {
    padding: 16,
    paddingBottom: 8,
  },
  messageContainer: {
    flexDirection: 'row',
    marginBottom: 16,
    alignItems: 'flex-end',
  },
  userMessageContainer: {
    justifyContent: 'flex-end',
  },
  aiMessageContainer: {
    justifyContent: 'flex-start',
  },
  aiAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#34C759',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  messageBubble: {
    maxWidth: '75%',
    padding: 12,
    borderRadius: 16,
  },
  userBubble: {
    backgroundColor: '#007AFF',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  userText: {
    color: '#FFFFFF',
  },
  aiText: {
    color: '#1C1E21',
  },
  suggestionsContainer: {
    marginTop: 12,
    gap: 8,
  },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F0F7FF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  suggestionText: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '500',
    flex: 1,
  },
  ticketAlert: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#34C759',
  },
  ticketAlertUrgent: {
    backgroundColor: '#FFEBEE',
    borderLeftColor: '#FF3B30',
  },
  ticketAlertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  ticketAlertTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1E21',
  },
  ticketId: {
    fontSize: 13,
    fontWeight: '500',
    color: '#007AFF',
    marginBottom: 4,
  },
  ticketSLA: {
    fontSize: 12,
    color: '#657786',
    marginBottom: 2,
  },
  ticketPriority: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1C1E21',
  },
  fraudAlert: {
    backgroundColor: '#FFF3E0',
    borderLeftColor: '#FF9500',
    borderLeftWidth: 4,
  },
  transactionsContainer: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#F8F9FA',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E4E6EB',
  },
  transactionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 8,
  },
  transactionItem: {
    padding: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#E4E6EB',
  },
  transactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  transactionAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1E21',
  },
  transactionId: {
    fontSize: 12,
    color: '#657786',
    flex: 1,
  },
  transactionStatus: {
    fontSize: 11,
    color: '#8899A6',
    marginTop: 2,
  },
  dataCollectionForm: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#007AFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  formTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1E21',
    flex: 1,
  },
  formField: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1C1E21',
    marginBottom: 6,
  },
  required: {
    color: '#FF3B30',
  },
  fieldInput: {
    backgroundColor: '#F5F7FA',
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#1C1E21',
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  formButtonPrimary: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  formButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  formButtonSecondary: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  formButtonSecondaryText: {
    color: '#657786',
    fontSize: 15,
    fontWeight: '600',
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#AAB8C2',
  },
  typingText: {
    fontSize: 13,
    color: '#657786',
    marginLeft: 6,
    fontStyle: 'italic',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E1E8ED',
    gap: 12,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1C1E21',
    maxHeight: 100,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});
