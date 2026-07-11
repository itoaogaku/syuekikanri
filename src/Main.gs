/**
 * Main.gs
 * -----------------------------------------------------------------------------
 * エントリポイント。メニュー、月次実行、トリガー設定、APIキー設定。
 */

/** スプレッドシートを開いたときにメニューを追加 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('売上レポート')
    .addItem('① APIキーを設定', 'setupApiKeys')
    .addSeparator()
    .addItem('② 先月のレポートを作成', 'runLastMonthReport')
    .addItem('③ 月を指定してレポート作成', 'runReportForChosenMonth')
    .addSeparator()
    .addItem('④ 毎月の自動作成をON（毎月5日）', 'createMonthlyTrigger')
    .addItem('　 自動作成をOFF', 'deleteMonthlyTrigger')
    .addSeparator()
    .addItem('★ サンプルデータで表示を確認', 'runSampleReport')
    .addToUi();
}

/** 先月分（前月1日〜末日）のレポートを作成 */
function runLastMonthReport() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed。0 のとき前月は前年12月
  const target = new Date(y, m - 1, 1); // 先月の1日
  runReportForMonth_(target.getFullYear(), target.getMonth() + 1);
}

/** ダイアログで年月を指定して作成 */
function runReportForChosenMonth() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('レポート作成', '対象の年月を入力（例: 2026-06）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const m = String(res.getResponseText()).match(/^(\d{4})[-\/](\d{1,2})$/);
  if (!m) { ui.alert('形式が不正です。例: 2026-06'); return; }
  runReportForMonth_(parseInt(m[1], 10), parseInt(m[2], 10));
}

/**
 * 指定した年月（1-indexed）のレポートを作成する本体。
 * @param {number} year
 * @param {number} month1
 */
function runReportForMonth_(year, month1) {
  const tz = 'Asia/Tokyo';
  const from = new Date(year, month1 - 1, 1, 0, 0, 0);
  const to = new Date(year, month1, 0, 23, 59, 59); // 当月末日
  const periodLabel = Utilities.formatDate(from, tz, 'yyyy年M月');

  const gteUnix = Math.floor(from.getTime() / 1000);
  const lteUnix = Math.floor(to.getTime() / 1000);

  if (!isStripeEnabled_() && !isKomojuEnabled_()) {
    SpreadsheetApp.getUi().alert('APIキーが未設定です。メニュー「① APIキーを設定」から入力してください。');
    return;
  }

  let txns = [];
  let stripePayouts = [];

  if (isStripeEnabled_()) {
    const s = stripeCollect_(gteUnix, lteUnix);
    txns = txns.concat(s.txns);
    stripePayouts = stripePayouts.concat(s.payouts);
  }
  if (isKomojuEnabled_()) {
    const k = komojuCollect_(from, to);
    txns = txns.concat(k.txns);
  }

  const agg = aggregate_(txns, stripePayouts);
  writeReport_(agg, periodLabel);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    periodLabel + 'のレポートを作成しました（取引 ' + txns.length + ' 件）', '完了', 5);
}

/** APIキーをダイアログで設定 */
function setupApiKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const stripe = ui.prompt('Stripe',
    'Stripe のシークレットキー（sk_...）を入力。使わない場合は空でOK。\n※読み取り専用の制限キー推奨。',
    ui.ButtonSet.OK_CANCEL);
  if (stripe.getSelectedButton() === ui.Button.OK) {
    const v = stripe.getResponseText().trim();
    if (v) props.setProperty(PROP_KEYS.STRIPE_SECRET, v);
  }

  const komoju = ui.prompt('Komoju',
    'Komoju のシークレットキーを入力。使わない場合は空でOK。',
    ui.ButtonSet.OK_CANCEL);
  if (komoju.getSelectedButton() === ui.Button.OK) {
    const v = komoju.getResponseText().trim();
    if (v) props.setProperty(PROP_KEYS.KOMOJU_SECRET, v);
  }

  const rate = ui.prompt('Komoju 手数料率（概算用）',
    'Komoju の決済手数料率を入力（例: 3.65% なら 0.0365）。空なら 0。',
    ui.ButtonSet.OK_CANCEL);
  if (rate.getSelectedButton() === ui.Button.OK) {
    const v = rate.getResponseText().trim();
    if (v) props.setProperty(PROP_KEYS.KOMOJU_FEE_RATE, v);
  }

  ui.alert('APIキーを保存しました。');
}

/** 毎月5日 午前9時台に前月分を自動作成するトリガーを設定 */
function createMonthlyTrigger() {
  deleteMonthlyTrigger();
  ScriptApp.newTrigger('runLastMonthReport')
    .timeBased()
    .onMonthDay(5)
    .atHour(9)
    .inTimezone('Asia/Tokyo')
    .create();
  SpreadsheetApp.getUi().alert('毎月5日 9時台に、前月分のレポートを自動作成します。');
}

/** 自動作成トリガーを削除 */
function deleteMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runLastMonthReport') ScriptApp.deleteTrigger(t);
  });
}
