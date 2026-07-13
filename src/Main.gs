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
    .addItem('②-2 KomojuにWixの商品名を反映（自動）', 'applyWixNamesToKomoju')
    .addItem('②-3 Komojuを仕分ける（手動・保険用）', 'openKomojuAssign')
    .addSeparator()
    .addItem('③ 先月分を取得して反映', 'runLastMonthReport')
    .addItem('④ 月を指定して取得', 'runReportForChosenMonth')
    .addItem('④-2 期間を一括取得（複数月）', 'runBulkImport')
    .addItem('⑤ レポートを再作成（取得済みデータから）', 'regenerateReports')
    .addSeparator()
    .addItem('⑥ 毎月の自動取得をON（毎月5日）', 'createMonthlyTrigger')
    .addItem('　 自動取得をOFF', 'deleteMonthlyTrigger')
    .addSeparator()
    .addItem('🔍 Komoju接続テスト', 'testKomoju')
    .addItem('🔍 Komoju精算(入金)データを調べる（診断）', 'testKomojuSettlements')
    .addItem('🔍 Stripe接続テスト', 'testStripe')
    .addItem('🔍 Wix接続＆注文一致テスト', 'testWix')
    .addItem('🔍 Wix注文を書き出す（診断）', 'dumpWixDiagnostic')
    .addItem('🔍 Wixイベントを調べる（診断）', 'testWixEvents')
    .addItem('🔍 Wixイベント購入データを調べる（診断）', 'testWixPurchases')
    .addItem('🔍 Wix支払い/フォームを調べる（診断）', 'testWixPayments')
    .addItem('🔍 Wix取引とKomojuを並べる（診断）', 'dumpWixTransactions')
    .addItem('🔍 Wix支払いのページ送りを調べる（診断）', 'testWixTxPaging')
    .addItem('★ サンプルデータで表示を確認', 'runSampleReport')
    .addToUi();
}

/**
 * Wixイベント系APIにアクセスできるか、有力なエンドポイントを順に試して
 * 「Wixイベント診断」シートに結果（ステータスと応答）を書き出す。
 */
function testWixEvents() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。「①」から設定してください。'); return; }
  try {
    const results = wixProbeEvents_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('Wixイベント診断');
    if (!sh) sh = ss.insertSheet('Wixイベント診断');
    sh.clear();
    const header = ['試した内容', 'メソッド', 'パス', 'ステータス', '応答(先頭3000字)'];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    const rows = results.map(function (r) {
      return [r.label, r.method, r.path, r.status, String(r.text).slice(0, 3000)];
    });
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    ss.setActiveSheet(sh);

    const ok = results.filter(function (r) { return r.status === 200; });
    let msg = 'Wixイベントの入口を ' + results.length + ' 通り試しました。\n';
    msg += '成功(200): ' + ok.length + ' 件\n';
    results.forEach(function (r) { msg += '・' + r.label + ' → ' + r.status + '\n'; });
    msg += '\n詳しい応答は「Wixイベント診断」シートに書き出しました。共有ください。';
    ui.alert(msg);
  } catch (e) {
    ui.alert('エラー ❌\n\n' + e.message);
  }
}

/** Wixの支払い/フォーム系APIの入口を探して「Wix支払い診断」シートに書き出す。 */
function testWixPayments() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。「①」から設定してください。'); return; }
  try {
    const results = wixProbePayments_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('Wix支払い診断');
    if (!sh) sh = ss.insertSheet('Wix支払い診断');
    sh.clear();
    const header = ['試した内容', 'メソッド', 'パス', 'ステータス', '応答(先頭4000字)'];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    const rows = results.map(function (r) {
      return [r.label, r.method, r.path, r.status, String(r.text).slice(0, 4000)];
    });
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    ss.setActiveSheet(sh);
    const ok = results.filter(function (r) { return r.status === 200; });
    let msg = '支払い/フォームの入口を ' + results.length + ' 通り試しました。\n成功(200): ' + ok.length + ' 件\n';
    results.forEach(function (r) { msg += '・' + r.label + ' → ' + r.status + '\n'; });
    msg += '\n詳しい応答は「Wix支払い診断」シートに書き出しました。共有ください。';
    ui.alert(msg);
  } catch (e) {
    ui.alert('エラー ❌\n\n' + e.message);
  }
}

/** 過去イベントの購入者・注文データの入口を探して「Wix購入診断」シートに書き出す。 */
function testWixPurchases() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。「①」から設定してください。'); return; }
  try {
    const results = wixProbePurchases_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('Wix購入診断');
    if (!sh) sh = ss.insertSheet('Wix購入診断');
    sh.clear();
    const header = ['試した内容', 'メソッド', 'パス', 'ステータス', '応答(先頭4000字)'];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (results.length) {
      const rows = results.map(function (r) {
        return [r.label, r.method, r.path, r.status, String(r.text).slice(0, 4000)];
      });
      sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
    ss.setActiveSheet(sh);
    const ok = results.filter(function (r) { return r.status === 200; });
    let msg = '購入データの入口を ' + results.length + ' 通り試しました。\n成功(200): ' + ok.length + ' 件\n';
    results.forEach(function (r) { msg += '・' + r.label + ' → ' + r.status + '\n'; });
    msg += '\n詳しい応答は「Wix購入診断」シートに書き出しました。共有ください。';
    ui.alert(msg);
  } catch (e) {
    ui.alert('エラー ❌\n\n' + e.message);
  }
}

/**
 * 指定月のWix注文を「Wix診断」シートに書き出す。
 * Komojuとの正しい突き合わせ方法を設計するための調査用。
 */
function dumpWixDiagnostic() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。「①」から設定してください。'); return; }
  const res = ui.prompt('Wix注文の書き出し', '対象の年月を入力（例: 2026-06）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const m = String(res.getResponseText()).match(/^(\d{4})[-\/](\d{1,2})$/);
  if (!m) { ui.alert('形式が不正です。例: 2026-06'); return; }
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  const from = new Date(y, mo - 1, 1, 0, 0, 0);
  const to = new Date(y, mo, 0, 23, 59, 59);

  try {
    const all = wixListOrdersDescUntil_(from);
    const orders = all.filter(function (o) {
      const d = new Date(o.createdDate);
      return d.getTime() >= from.getTime() && d.getTime() <= to.getTime();
    });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('Wix診断');
    if (!sh) sh = ss.insertSheet('Wix診断');
    sh.clear();
    const header = ['注文番号', '注文ID', '作成日', '合計金額', '商品名', '生データ(先頭4000字)'];
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    const rows = orders.map(function (o) {
      return [o.number, o.id, o.createdDate, wixTotal_(o), wixOrderProductLabel_(o),
        JSON.stringify(o).slice(0, 4000)];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    ss.setActiveSheet(sh);
    ui.alert(orders.length + ' 件のWix注文を「Wix診断」シートに書き出しました。\n' +
      'このシートを（Komoju明細とあわせて）共有いただければ、正しい紐付けを作ります。');
  } catch (e) {
    ui.alert('Wix注文の取得エラー ❌\n\n' + e.message);
  }
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
    let msg = 'Wix 接続OK ✅\n';

    // 台帳のKomojuコードで、Wixの注文を「直接1件取得」できるか試す（これが本番と同じ方式）
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const komoju = readLedger_(ss).filter(function (t) { return t.source === 'Komoju'; });
    if (!komoju.length) {
      msg += '\n台帳にKomojuデータがありません。先に「④」でKomojuのある月を取得してください。';
      ui.alert(msg);
      return;
    }

    const tryCount = Math.min(komoju.length, 8);
    let ok = 0;
    const samples = [];
    for (let i = 0; i < tryCount; i++) {
      const code = String(komoju[i].orderId || komoju[i].product);
      const order = wixGetOrderById_(code);
      if (order) {
        ok++;
        if (samples.length < 4) samples.push('  ' + code.slice(0, 8) + '… → ' + (wixOrderProductLabel_(order) || '(商品名なし)'));
      } else {
        if (samples.length < 4) samples.push('  ' + code.slice(0, 8) + '… → 見つからず');
      }
    }
    msg += '\nKomojuコードでWix注文を取得できた数: ' + ok + ' / ' + tryCount + ' 件（試行）\n';
    msg += samples.join('\n');
    if (ok === 0) {
      msg += '\n\n→ Komojuのコードは Wix の注文ID とは別物のようです。' +
        '別の突き合わせ方法（注文番号や金額＋日付）を検討します。結果を共有してください。';
    } else {
      msg += '\n\n→ 取得できています！「④」で対象月を取り直すと、Komojuに商品名が入ります。';
    }
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

/** Komojuの精算（入金/振込）データの入口を探して「Komoju精算診断」に書き出す。 */
function testKomojuSettlements() {
  const ui = SpreadsheetApp.getUi();
  if (!isKomojuEnabled_()) { ui.alert('Komojuのキーが未設定です。'); return; }
  const results = komojuProbeSettlements_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Komoju精算診断');
  if (!sh) sh = ss.insertSheet('Komoju精算診断');
  sh.clear();
  const header = ['パス', 'ステータス', '応答(先頭3500字)'];
  sh.getRange(1, 1, 1, 3).setValues([header]).setFontWeight('bold');
  const rows = results.map(function (r) { return [r.path, r.status, String(r.text).slice(0, 3500)]; });
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  ss.setActiveSheet(sh);
  const ok = results.filter(function (r) { return r.status === 200; });
  let msg = 'Komojuの精算データの入口を ' + results.length + ' 通り試しました。\n成功(200): ' + ok.length + ' 件\n';
  results.forEach(function (r) { msg += '・' + r.path + ' → ' + r.status + '\n'; });
  msg += '\n詳しい応答は「Komoju精算診断」シートに書き出しました。共有ください。';
  ui.alert(msg);
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

  // Komojuの新しい注文コードを仕分けシートへ追記（未分類として）
  if (fetchedSources.indexOf('Komoju') !== -1) {
    try { refreshKomojuAssign_(ss); } catch (e) { /* 継続 */ }
  }

  regenerateReports();

  ss.toast(yearMonth + ' 分を反映しました（取引 ' + txns.length + ' 件）。台帳に蓄積されています。', '完了', 6);
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
  // buildReports_ で product は Komoju仕分けも反映済み。その txns から提出用明細を作成
  writeSubmissionSheet_(ss, txns);
  ss.toast('レポートを再作成しました。', '完了', 4);
}

/** 支払い取引のページ送り方法を特定して「Wixページ診断」に書き出す。 */
function testWixTxPaging() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = wixProbeTxPaging_();
  let sh = ss.getSheetByName('Wixページ診断');
  if (!sh) sh = ss.insertSheet('Wixページ診断');
  sh.clear();
  const header = ['試した内容', 'ステータス', '件数', 'メモ'];
  sh.getRange(1, 1, 1, 4).setValues([header]).setFontWeight('bold');
  const rows = results.map(function (r) { return [r.label, r.status, r.count, r.note]; });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  ss.setActiveSheet(sh);
  let msg = 'ページ送りを調べました。\n';
  results.forEach(function (r) { msg += '・' + r.label + ' : ' + r.count + '件 ' + (r.note || '') + '\n'; });
  msg += '\n「Wixページ診断」シートも共有ください。';
  ui.alert(msg);
}

/** Wixの支払いデータとKomoju明細を並べて「Wix取引診断」に書き出す（原因調査用）。 */
function dumpWixTransactions() {
  const ui = SpreadsheetApp.getUi();
  if (!isWixEnabled_()) { ui.alert('Wixが未設定です。'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1ページ目を生取得（ページ送りの構造も見る）
  const r = wixTry_('get', '/payments/v2/transactions?cursorPaging.limit=100', null);
  let j = {};
  try { j = JSON.parse(r.text); } catch (e) { }
  const txs = j.transactions || [];
  const meta = j.pagingMetadata || j.metadata || {};

  // 台帳のKomoju明細も取得
  const komoju = readLedger_(ss).filter(function (t) { return t.source === 'Komoju'; });

  let sh = ss.getSheetByName('Wix取引診断');
  if (!sh) sh = ss.insertSheet('Wix取引診断');
  sh.clear();
  const rows = [];
  rows.push(['●メタ情報']);
  rows.push(['status', r.status]);
  rows.push(['取得できた取引数(1ページ)', txs.length]);
  rows.push(['応答のキー', Object.keys(j).join(', ')]);
  rows.push(['pagingMetadata(生)', JSON.stringify(meta).slice(0, 1500)]);
  const dates = txs.map(function (t) { return t.createdAt; }).filter(Boolean).sort();
  rows.push(['取引の日付範囲', (dates[0] || '') + ' 〜 ' + (dates[dates.length - 1] || '')]);
  rows.push([]);
  rows.push(['●Wix支払い（provider / 金額 / 日付JST / providerTransactionId / 商品名）']);
  txs.forEach(function (t) {
    rows.push([
      t.provider,
      t.amount ? t.amount.amount : '',
      t.createdAt ? Utilities.formatDate(new Date(t.createdAt), 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      t.providerTransactionId || '',
      wixTxProductName_(t),
    ]);
  });
  rows.push([]);
  rows.push(['●Komoju明細（台帳）（id / 金額 / 日付JST / 商品コード）']);
  komoju.forEach(function (t) {
    rows.push([
      t.id,
      t.gross,
      Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy-MM-dd'),
      t.product,
    ]);
  });

  // 書き込み（列数を揃える）
  const maxc = 5;
  const padded = rows.map(function (rw) { while (rw.length < maxc) rw.push(''); return rw.slice(0, maxc); });
  sh.getRange(1, 1, padded.length, maxc).setValues(padded);
  ss.setActiveSheet(sh);
  ui.alert('「Wix取引診断」に書き出しました。\n1ページの取得数: ' + txs.length +
    '\n日付範囲: ' + (dates[0] || '') + ' 〜 ' + (dates[dates.length - 1] || '') +
    '\n\nこのシートを共有ください。');
}

/**
 * 台帳に既にあるKomoju明細に、Wixの支払いデータから商品名を反映する
 * （再取得なし）。金額＋日付／決済IDで突き合わせる。
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
    '　- 決済IDで一致: ' + r.byId + ' 件\n' +
    '　- 金額＋日付で一致: ' + r.byAmt + ' 件\n' +
    '　- 未補完: ' + (komoju.length - r.filled) + ' 件\n\n' +
    '※ 未補完（同額・同日で商品を特定できない分）は「②-3 手動タグ付け」で対応できます。');
}

/** Komoju仕分けシートを開く（未分類を最新化して表示） */
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
