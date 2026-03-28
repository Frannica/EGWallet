$BASE = "https://egwalletsimple-production.up.railway.app"
$ts   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Req {
  param($method, $path, $body, $token)
  $headers = @{ "Content-Type" = "application/json" }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  $params  = @{ Uri = "$BASE$path"; Method = $method; Headers = $headers; ErrorAction = "Stop" }
  if ($body) { $params["Body"] = ($body | ConvertTo-Json -Depth 5) }
  Invoke-RestMethod @params
}

function ToMajor {
  param($cur, $minor)
  $zero = @("XOF","UGX","RWF","JPY","KRW","IDR","VND","PYG","GNF","BIF","DJF","KMF","MGA")
  if ($zero -contains $cur) { return $minor }
  return [math]::Round($minor / 100, 2)
}

function RunScenario {
  param($label, $sRegion, $rRegion, $sendCurrency, $fundMinor, $sendMinor)
  Write-Host ""
  Write-Host ("=" * 65) -ForegroundColor Cyan
  Write-Host "  $label" -ForegroundColor Cyan
  Write-Host ("=" * 65) -ForegroundColor Cyan

  $sender   = Req POST /auth/register @{ email="sx${sRegion}${ts}@fxio.com"; password="Fx1234!#"; region=$sRegion }
  $receiver = Req POST /auth/register @{ email="rx${rRegion}${ts}@fxio.com"; password="Fx1234!#"; region=$rRegion }

  Write-Host "  Sender   region=$sRegion  preferredCurrency = $($sender.user.preferredCurrency)"
  Write-Host "  Receiver region=$rRegion  preferredCurrency = $($receiver.user.preferredCurrency)"

  $intent = Req POST /deposits/create-intent @{ amount=$fundMinor; currency=$sendCurrency; walletId=$sender.walletId } $sender.token
  Req POST /deposits/confirm @{ intentId=$intent.intentId; walletId=$sender.walletId } $sender.token | Out-Null
  Write-Host "  Funded sender: $(ToMajor $sendCurrency $fundMinor) $sendCurrency"

  $txResp = Req POST /transactions @{
    fromWalletId = $sender.walletId
    toWalletId   = $receiver.walletId
    amount       = $sendMinor
    currency     = $sendCurrency
    memo         = $label
  } $sender.token

  $tx = $txResp.transaction
  $sentM = ToMajor $tx.currency $tx.amount
  $recvM = ToMajor $tx.receivedCurrency $tx.receivedAmount

  Write-Host ""
  Write-Host "  REQUEST  POST /transactions"
  Write-Host "    amount       : $($tx.amount) minor ($sentM $sendCurrency)"
  Write-Host "  RESPONSE:"
  Write-Host "    id               : $($tx.id)" -ForegroundColor White
  Write-Host "    currency         : $($tx.currency)   amount: $($tx.amount) minor = $sentM $($tx.currency)" -ForegroundColor Green
  Write-Host "    receivedCurrency : $($tx.receivedCurrency)   receivedAmount: $($tx.receivedAmount) minor = $recvM $($tx.receivedCurrency)" -ForegroundColor Yellow
  Write-Host "    wasConverted     : $($tx.wasConverted)" -ForegroundColor Magenta

  if ($tx.currency -ne $tx.receivedCurrency -and $sentM -gt 0) {
    $rate = [math]::Round($recvM / $sentM, 6)
    Write-Host "    Exchange rate    : 1 $($tx.currency) = $rate $($tx.receivedCurrency)" -ForegroundColor Magenta
  }

  $rwb = (Req GET /wallets $null $receiver.token).wallets[0].balances
  Write-Host "  Receiver wallet after:"
  foreach ($b in $rwb) {
    Write-Host "    $($b.currency) : $(ToMajor $b.currency $b.amount) major  ($($b.amount) minor)" -ForegroundColor Yellow
  }
}

RunScenario "SCENARIO 1: XAF -> USD  (Equatorial Guinea -> United States)" "GQ" "US" "XAF" 500000 200000
RunScenario "SCENARIO 2: EUR -> NGN  (France -> Nigeria)"                  "FR" "NG" "EUR" 100000  50000
RunScenario "SCENARIO 3: GHS -> GBP  (Ghana -> United Kingdom)"            "GH" "GB" "GHS" 500000 200000
RunScenario "SCENARIO 4: XOF -> BRL  (Senegal -> Brazil)"                  "SN" "BR" "XOF" 500000 200000

Write-Host ""
Write-Host ("=" * 65) -ForegroundColor Green
Write-Host "  ALL 4 SCENARIOS COMPLETE" -ForegroundColor Green
Write-Host ("=" * 65) -ForegroundColor Green
