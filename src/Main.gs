/**
 * Main.gs
 * -----------------------------------------------------------------------------
 * エントリポイント。メニュー、月次取得（台帳へ蓄積）、レポート再生成、
 * トリガー設定、APIキー設定。
 *
 * 流れ:
 *   月次実行 → その月の取引を取得 → 台帳（明細DB/入金DB）へ追記・更新
 *          → 台帳全体から 年度サマリー・事業別・商品別・決済手段別・入金照合・提出用明細 を再生成
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('売上レポート')
    .addItem('① APIキー・年度開始月を設定', 'setupApiKeys')
    .addItem('② 事業マッピングを編集', 'openMappingSheet')
    .addItem('②-2 KomojuにWixの商品名を反映（自動）', 'applyWixNamesToKomoju')
    .addItem('②-3 Komojuを仕分ける（手動）', 'openKomojuAssign')
    .addSeparator()
    .addItem('③ 先月分を取得して反映', 'runLastMonthReport')
    .addItem('④ 月を指定して取得', 'runReportForChosenMonth')
    .addItem('④-2 期間を一括取得（複数月）', 'runBulkImport')
    .addItem('⑤ レポートを再作成（取得済みデータから）', 'regenerateReports')
    .addSeparator()
    .addItem('⑥ 毎月の自動取得をON（毎月5日）', 'createMonthlyTrigger')
    .addItem('　 自動取得をOFF', 'deleteMonthlyTrigger')
    .addToUi();
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

/** 指定した年月のデータを取得して台帳へ upsert し、全レポートを再生成。 */
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
    // Wixが設定されていれば、Komojuの商品名をWixの支払いデータから補う（失敗しても継続）
    try { wixEnrichKomojuTxns_(k.txns); } catch (e) { /* Wix不調時は元のコードのまま */ }
    txns = txns.concat(k.txns);
    fetchedSources.push('Komoju');
    // Komojuの実際の入金（精算）をこの月分だけ入金台帳へ
    try {
      const netSum = k.txns.reduce(function (s, t) { return s + t.net; }, 0);
      const setls = komojuListAllSettlements_().map(komojuSettlementRecord_)
        .filter(function (p) { return p.yearMonth === yearMonth; });
      setls.forEach(function (p) { p.calculatedNet = Math.round(netSum); });
      payouts = payouts.concat(setls);
    } catch (e) { /* 精算取得に失敗しても継続 */ }
  }

  // 台帳へ蓄積（その月・そのサービス分を入れ替え）
  upsertLedger_(ss, txns, yearMonth, fetchedSources);
  upsertPayoutLedger_(ss, payouts, yearMonth, fetchedSources);

  // Komojuの新しい注文コードを仕分けシートへ追記（未補完のもののみ）
  if (fetchedSources.indexOf('Komoju') !== -1) {
    try { refreshKomojuAssign_(ss); } catch (e) { /* 継続 */ }
  }

  regenerateReports();
  ss.toast(yearMonth + ' 分を反映しました（取引 ' + txns.length + ' 件）。', '完了', 6);
}

/**
 * 期間を指定して複数月を一括取得する。
 * Komoju・Wix支払いは期間分を1回だけ取得して各月へ振り分け（高速化）。
 * 実行時間の上限（約6分）に近づいたら安全に中断し、続きの期間を案内する。
 */
function runBulkImport() {
  const ui = SpreadsheetApp.getUi();
  if (!isStripeEnabled_() && !isKomojuEnabled_()) {
    ui.alert('APIキーが未設定です。「①」から入力してください。');
    return;
  }
  const res = ui.prompt('期間を一括取得',
    '開始と終了の年月を入力してください（例: 2025-04 〜 2026-03）。\n※一度に取り込むのは2年分くらいまでを目安に。',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const m = String(res.getResponseText()).match(/(\d{4})[-\/](\d{1,2})\D+(\d{4})[-\/](\d{1,2})/);
  if (!m) { ui.alert('形式が不正です。例: 2025-04 〜 2026-03'); return; }
  const sy = +m[1], sm = +m[2], ey = +m[3], em = +m[4];

  // 対象月リストを作成
  const months = [];
  let y = sy, mo = sm, guard = 0;
  while (guard++ < 300) {
    if (y > ey || (y === ey && mo > em)) break;
    months.push([y, mo]);
    mo++; if (mo > 12) { mo = 1; y++; }
  }
  if (!months.length) { ui.alert('期間が正しくありません（開始が終了より後です）。'); return; }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rangeFrom = new Date(sy, sm - 1, 1, 0, 0, 0);
  const rangeTo = new Date(ey, em, 0, 23, 59, 59);

  // Komoju を期間分まとめて取得し、Wix支払いの索引で商品名を一括付与、月ごとに振り分け
  const komojuByYm = {};
  const komojuSetlByYm = {};
  if (isKomojuEnabled_()) {
    const k = komojuCollect_(rangeFrom, rangeTo);
    try {
      if (isWixEnabled_()) {
        const idx = wixBuildTxIndex_(new Date(rangeFrom.getTime() - 4 * 86400000));
        wixApplyKomojuIndex_(k.txns, idx);
      }
    } catch (e) { /* Wix不調でも継続 */ }
    k.txns.forEach(function (t) {
      const ym = Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy-MM');
      (komojuByYm[ym] = komojuByYm[ym] || []).push(t);
    });
    // 精算（実際の入金）も一度だけ取得して月ごとに振り分け
    try {
      komojuListAllSettlements_().map(komojuSettlementRecord_).forEach(function (p) {
        if (p.yearMonth) (komojuSetlByYm[p.yearMonth] = komojuSetlByYm[p.yearMonth] || []).push(p);
      });
    } catch (e) { /* 継続 */ }
  }

  let total = 0, done = 0, stoppedAt = null;
  const t0 = Date.now();
  for (let i = 0; i < months.length; i++) {
    if (Date.now() - t0 > 5 * 60 * 1000) { stoppedAt = months[i]; break; } // 時間切れ前に中断
    const yy = months[i][0], mm = months[i][1];
    const from = new Date(yy, mm - 1, 1, 0, 0, 0);
    const to = new Date(yy, mm, 0, 23, 59, 59);
    const ym = Utilities.formatDate(from, 'Asia/Tokyo', 'yyyy-MM');
    let txns = [], payouts = [];
    const sources = [];
    if (isStripeEnabled_()) {
      const s = stripeCollect_(Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000));
      txns = txns.concat(s.txns);
      payouts = payouts.concat(s.payouts);
      sources.push('Stripe');
    }
    if (isKomojuEnabled_()) {
      const kt = komojuByYm[ym] || [];
      txns = txns.concat(kt);
      sources.push('Komoju');
      const netSum = kt.reduce(function (s, t) { return s + t.net; }, 0);
      (komojuSetlByYm[ym] || []).forEach(function (p) { p.calculatedNet = Math.round(netSum); payouts.push(p); });
    }
    upsertLedger_(ss, txns, ym, sources);
    upsertPayoutLedger_(ss, payouts, ym, sources);
    total += txns.length; done++;
  }

  try { refreshKomojuAssign_(ss); } catch (e) { }
  regenerateReports();

  let msg = '一括取得が完了しました。\n取り込んだ月数: ' + done + ' ／ 取引合計: ' + total + ' 件';
  if (stoppedAt) {
    const sa = stoppedAt[0] + '-' + ('0' + stoppedAt[1]).slice(-2);
    msg += '\n\n⚠ 実行時間の都合で ' + sa + ' 以降は未取得です。\n' +
      'もう一度「④-2」で「' + sa + ' 〜 ' + ey + '-' + ('0' + em).slice(-2) + '」を実行してください（重複はしません）。';
  }
  SpreadsheetApp.getUi().alert(msg);
}

/** 台帳（取得済みデータ）から全レポートを再生成。事業マッピング変更後などに使う。 */
function regenerateReports() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txns = readLedger_(ss);
  const payouts = readPayoutLedger_(ss);
  const rules = loadBusinessRules_(ss);
  const komojuAssign = loadKomojuAssign_(ss);
  const reports = buildReports_(txns, rules, payouts, komojuAssign);
  writeAllReports_(ss, reports);
  // buildReports_ で product・business は反映済み。その txns から提出用明細を作成
  writeSubmissionSheet_(ss, txns);
  ss.toast('レポートを再作成しました。', '完了', 4);
}

/**
 * 台帳に既にあるKomoju明細に、Wixの支払いデータから商品名を反映する（再取得なし）。
 * 金額＋日付／決済IDで突き合わせる。
 */
function applyWixNamesToKomoju() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。「①」から設定してください。'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const all = readLedger_(ss);
  const komoju = all.filter(function (t) { return t.source === 'Komoju'; });
  if (!komoju.length) { ui.alert('台帳にKomoju明細がありません。先に「③/④」で取得してください。'); return; }

  let r = { filled: 0, byId: 0, byAmt: 0 };
  try {
    r = wixEnrichKomojuTxns_(komoju); // komoju は all 内の同じ参照を書き換える
  } catch (e) {
    ui.alert('Wix突き合わせでエラー ❌\n\n' + e.message);
    return;
  }
  rewriteLedger_(ss, all);
  regenerateReports();

  ui.alert('Wixの支払いデータと突き合わせました。\n\n' +
    '商品名を補完: ' + r.filled + ' / ' + komoju.length + ' 件\n' +
    '　- 未補完: ' + (komoju.length - r.filled) + ' 件\n\n' +
    '※ 未補完（同額・同日で商品を特定できない分）は「②-3 手動タグ付け」で対応できます。');
}

/** Komoju仕分けシートを開く（未補完のものを最新化して表示） */
function openKomojuAssign() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const r = refreshKomojuAssign_(ss);
  ss.setActiveSheet(ss.getSheetByName(SHEETS.KOMOJU_ASSIGN));
  SpreadsheetApp.getUi().alert(
    'Komoju仕分けシートを開きました。\n\n' +
    '「事業」列をプルダウンで選んでください（商品名の記入は任意）。\n' +
    '新規追加: ' + r.added + ' 件 ／ 未割り当て（空欄）: ' + r.blank + ' 件\n\n' +
    '選び終えたら「⑤ レポートを再作成」で反映されます。');
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
    'Stripe のシークレットキー（sk_.../rk_...）を入力。使わない/変更しない場合は空でOK。',
    ui.ButtonSet.OK_CANCEL);
  if (stripe.getSelectedButton() === ui.Button.OK && stripe.getResponseText().trim()) {
    props.setProperty(PROP_KEYS.STRIPE_SECRET, stripe.getResponseText().trim());
  }

  const komoju = ui.prompt('Komoju',
    'Komoju のシークレットキー（非公開鍵）を入力。使わない/変更しない場合は空でOK。',
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
