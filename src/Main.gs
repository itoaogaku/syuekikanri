/**
 * Main.gs
 * -----------------------------------------------------------------------------
 * エントリポイント。メニュー、月次取得（台帳へ蓄積）、レポート再生成、
 * トリガー設定、APIキー設定。
 *
 * 流れ:
 *   月次実行 → その月の取引を取得 → 台帳（明細DB/入金DB）へ追記・更新
 *          → 台帳全体から 年度サマリー・事業別・商品別・決済手段別・入金照合 を再生成
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('売上レポート')
    .addItem('① APIキー・年度開始月を設定', 'setupApiKeys')
    .addItem('② 事業マッピングを編集', 'openMappingSheet')
    .addSeparator()
    .addItem('③ 先月分を取得して反映', 'runLastMonthReport')
    .addItem('④ 月を指定して取得', 'runReportForChosenMonth')
    .addItem('⑤ レポートを再作成（取得済みデータから）', 'regenerateReports')
    .addSeparator()
    .addItem('⑥ 毎月の自動取得をON（毎月5日）', 'createMonthlyTrigger')
    .addItem('　 自動取得をOFF', 'deleteMonthlyTrigger')
    .addSeparator()
    .addItem('🔍 Komoju接続テスト', 'testKomoju')
    .addItem('🔍 Stripe接続テスト', 'testStripe')
    .addItem('🔍 Wix接続＆注文一致テスト', 'testWix')
    .addItem('★ サンプルデータで表示を確認', 'runSampleReport')
    .addToUi();
}

/**
 * Wix への接続確認。Wixの注文を取得し、台帳のKomoju注文コードと
 * 一致するか（＝商品名を補えるか）を確認する。
 */
function testWix() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) {
    ui.alert('Wixの APIキー / サイトID が未設定です。「①」から設定してください。');
    return;
  }
  try {
    const orders = wixSearchOrders_(100);
    const byId = {}, byNum = {};
    orders.forEach(function (o) {
      byId[o.id] = o;
      if (o.number != null) byNum[String(o.number)] = o;
    });

    let msg = 'Wix 接続OK ✅\n取得できた注文: ' + orders.length + ' 件\n';
    if (orders.length) {
      const o = orders[0];
      msg += '\n［最新注文の例］\n注文ID: ' + o.id + '\n注文番号: ' + o.number +
        '\n商品名: ' + (wixOrderProductLabel_(o) || '(なし)') + '\n';
    }

    // 台帳のKomojuコードと一致するか
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const komoju = readLedger_(ss).filter(function (t) { return t.source === 'Komoju'; });
    let matched = 0;
    const samples = [];
    komoju.forEach(function (t) {
      const code = String(t.product);
      const o = byId[code] || byNum[code];
      if (o) {
        matched++;
        if (samples.length < 3) samples.push('  ' + code.slice(0, 12) + '… → ' + wixOrderProductLabel_(o));
      }
    });
    msg += '\nKomoju注文コードとの一致: ' + matched + ' / ' + komoju.length + ' 件';
    if (samples.length) msg += '\n' + samples.join('\n');
    else if (komoju.length) msg += '\n（一致なし：取得注文数を増やすか、突き合わせ方法の調整が必要かもしれません）';

    ui.alert(msg);
  } catch (e) {
    ui.alert('Wix 接続エラー ❌\n\n' + e.message +
      '\n\nAPIキー・サイトID・アカウントID・権限（Orders 読み取り）をご確認ください。');
  }
}

/** Komoju への接続確認。件数や1件の中身を表示して原因を切り分ける。 */
function testKomoju() {
  const ui = SpreadsheetApp.getUi();
  if (!isKomojuEnabled_()) {
    ui.alert('Komojuのキーが未設定です。「①」で非公開鍵（シークレットキー）を入れてください。');
    return;
  }
  try {
    const q = buildQuery_([['per_page', 5], ['limit', 5], ['page', 1]]);
    const json = httpGetJson_(KOMOJU_BASE + '/payments?' + q, komojuHeaders_());
    const data = json.data || [];
    let msg = 'Komoju 接続OK ✅\n';
    msg += '登録されている決済の総件数: ' + (json.total != null ? json.total : '不明') + '\n';
    msg += '取得できたサンプル: ' + data.length + ' 件\n';
    if (data.length) {
      const p = data[0];
      msg += '\n［最新1件の中身］\n';
      msg += '日付: ' + (p.created_at || p.captured_at || '?') + '\n';
      msg += '金額: ' + p.amount + ' 円\n';
      msg += 'ステータス: ' + p.status + '\n';
      msg += '決済手段: ' + (p.payment_details && p.payment_details.type) + '\n';
      msg += '商品/説明: ' + (p.description || p.external_order_num || '(なし)');
    } else {
      msg += '\n※ 決済が0件です。テスト環境の店舗キーになっていないかご確認ください。';
    }
    ui.alert(msg);
  } catch (e) {
    ui.alert('Komoju 接続エラー ❌\n\n' + e.message +
      '\n\nキーの種類（非公開鍵か）・店舗が正しいかご確認ください。');
  }
}

/** Stripe への接続確認。 */
function testStripe() {
  const ui = SpreadsheetApp.getUi();
  if (!isStripeEnabled_()) {
    ui.alert('Stripeのキーが未設定です。「①」で rk_live_... を入れてください。');
    return;
  }
  try {
    const json = httpGetJson_(STRIPE_BASE + '/payouts?' + buildQuery_([['limit', 3]]), stripeHeaders_());
    const n = (json.data || []).length;
    ui.alert('Stripe 接続OK ✅\n直近の入金(payout)を ' + n + ' 件確認できました。');
  } catch (e) {
    ui.alert('Stripe 接続エラー ❌\n\n' + e.message);
  }
}

/** 先月分を取得して台帳へ反映 */
function runLastMonthReport() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1); // 先月の1日
  runReportForMonth_(target.getFullYear(), target.getMonth() + 1);
}

/** 年月を指定して取得 */
function runReportForChosenMonth() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('データ取得', '対象の年月を入力（例: 2026-06）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const m = String(res.getResponseText()).match(/^(\d{4})[-\/](\d{1,2})$/);
  if (!m) { ui.alert('形式が不正です。例: 2026-06'); return; }
  runReportForMonth_(parseInt(m[1], 10), parseInt(m[2], 10));
}

/**
 * 指定した年月のデータを取得して台帳へ upsert し、全レポートを再生成。
 */
function runReportForMonth_(year, month1) {
  const from = new Date(year, month1 - 1, 1, 0, 0, 0);
  const to = new Date(year, month1, 0, 23, 59, 59);
  const yearMonth = Utilities.formatDate(from, 'Asia/Tokyo', 'yyyy-MM');
  const gteUnix = Math.floor(from.getTime() / 1000);
  const lteUnix = Math.floor(to.getTime() / 1000);

  if (!isStripeEnabled_() && !isKomojuEnabled_()) {
    SpreadsheetApp.getUi().alert('APIキーが未設定です。メニュー「①」から入力してください。');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let txns = [];
  let payouts = [];
  const fetchedSources = [];

  if (isStripeEnabled_()) {
    const s = stripeCollect_(gteUnix, lteUnix);
    txns = txns.concat(s.txns);
    payouts = payouts.concat(s.payouts);
    fetchedSources.push('Stripe');
  }
  if (isKomojuEnabled_()) {
    const k = komojuCollect_(from, to);
    // Wixが設定されていれば、Komojuの商品名をWixの注文から補う（失敗しても本体は継続）
    try { wixEnrichKomojuTxns_(k.txns); } catch (e) { /* Wix不調時は元のコードのまま */ }
    txns = txns.concat(k.txns);
    fetchedSources.push('Komoju');
  }

  // 台帳へ蓄積（その月・そのサービス分を入れ替え）
  upsertLedger_(ss, txns, yearMonth, fetchedSources);
  upsertPayoutLedger_(ss, payouts, yearMonth, fetchedSources);

  regenerateReports();

  ss.toast(yearMonth + ' 分を反映しました（取引 ' + txns.length + ' 件）。台帳に蓄積されています。', '完了', 6);
}

/** 台帳（取得済みデータ）から全レポートを再生成。事業マッピング変更後などに使う。 */
function regenerateReports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txns = readLedger_(ss);
  const payouts = readPayoutLedger_(ss);
  const rules = loadBusinessRules_(ss);
  const reports = buildReports_(txns, rules, payouts);
  writeAllReports_(ss, reports);
  ss.toast('レポートを再作成しました。', '完了', 4);
}

/** 事業マッピングシートを開く（無ければ作成） */
function openMappingSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureMappingSheet_(ss);
  ss.setActiveSheet(sh);
  SpreadsheetApp.getUi().alert('「事業マッピング」シートで、キーワードと事業名を編集してください。\n編集後は「⑤ レポートを再作成」で反映されます。');
}

/** APIキーと年度開始月を設定 */
function setupApiKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const stripe = ui.prompt('Stripe',
    'Stripe のシークレットキー（sk_...）を入力。使わない/変更しない場合は空でOK。',
    ui.ButtonSet.OK_CANCEL);
  if (stripe.getSelectedButton() === ui.Button.OK && stripe.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.STRIPE_SECRET, stripe.getResponseText().trim());
  }

  const komoju = ui.prompt('Komoju',
    'Komoju のシークレットキーを入力。使わない/変更しない場合は空でOK。',
    ui.ButtonSet.OK_CANCEL);
  if (komoju.getSelectedButton() === ui.Button.OK && komoju.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.KOMOJU_SECRET, komoju.getResponseText().trim());
  }

  const rate = ui.prompt('Komoju 手数料率（概算用）',
    'Komoju の決済手数料率（例: 3.65% → 0.0365）。変更しない場合は空。',
    ui.ButtonSet.OK_CANCEL);
  if (rate.getSelectedButton() === ui.Button.OK && rate.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.KOMOJU_FEE_RATE, rate.getResponseText().trim());
  }

  const fiscal = ui.prompt('年度の開始月',
    '会計年度の開始月を 1〜12 で入力（例: 4月始まり→ 4、暦年→ 1）。既定は 4。変更しない場合は空。',
    ui.ButtonSet.OK_CANCEL);
  if (fiscal.getSelectedButton() === ui.Button.OK && fiscal.getResponseText().trim()) {
    const n = parseInt(fiscal.getResponseText().trim(), 10);
    if (n >= 1 && n <= 12) props.setProperty(PROP_KEYS.FISCAL_START, String(n));
  }

  const wixKey = ui.prompt('Wix APIキー',
    'Komojuの商品名をWixから補う場合に入力。使わない/変更しない場合は空でOK。',
    ui.ButtonSet.OK_CANCEL);
  if (wixKey.getSelectedButton() === ui.Button.OK && wixKey.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.WIX_API_KEY, wixKey.getResponseText().trim());
  }

  const wixSite = ui.prompt('Wix サイトID',
    'Wix の Site ID（管理画面 dashboard/【ここ】/home のID）。変更しない場合は空。',
    ui.ButtonSet.OK_CANCEL);
  if (wixSite.getSelectedButton() === ui.Button.OK && wixSite.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.WIX_SITE_ID, wixSite.getResponseText().trim());
  }

  const wixAccount = ui.prompt('Wix アカウントID',
    'Wix の Account ID。変更しない場合は空。',
    ui.ButtonSet.OK_CANCEL);
  if (wixAccount.getSelectedButton() === ui.Button.OK && wixAccount.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.WIX_ACCOUNT_ID, wixAccount.getResponseText().trim());
  }

  ui.alert('設定を保存しました。');
}

/** 毎月5日 午前9時台に前月分を自動取得するトリガー */
function createMonthlyTrigger() {
  deleteMonthlyTrigger();
  ScriptApp.newTrigger('runLastMonthReport')
    .timeBased()
    .onMonthDay(5)
    .atHour(9)
    .inTimezone('Asia/Tokyo')
    .create();
  SpreadsheetApp.getUi().alert('毎月5日 9時台に、前月分を自動取得して台帳へ反映します。');
}

function deleteMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runLastMonthReport') ScriptApp.deleteTrigger(t);
  });
}
