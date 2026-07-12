/**
 * Ledger.gs
 * -----------------------------------------------------------------------------
 * 取引・入金を「台帳」シートに蓄積する（年間でどんどん追記されていく元データ）。
 *
 * 月次実行のたびに上書きするのではなく、この台帳に追記・更新していきます。
 * 各レポート（年度サマリー・事業別など）は、この台帳を読み直して再生成します。
 *
 * 重複防止:
 *   ある月・あるサービスを再実行したときは、その (yearMonth × source) の行を
 *   一度削除してから入れ直します（遅れて発生した返金なども反映されます）。
 */

/** 明細台帳の列 */
const LEDGER_COLS = [
  'source', 'id', 'date', 'yearMonth', 'kind', 'type',
  'product', 'orderId', 'method', 'gross', 'fee', 'net',
  'payoutId', 'payoutDate',
];

/** 入金台帳の列 */
const PAYOUT_COLS = [
  'source', 'payoutId', 'arrivalDate', 'yearMonth', 'payoutAmount', 'calculatedNet', 'status',
];

function ensureSheetWithHeader_(ss, name, header) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** yyyy-MM 文字列 */
function formatYm_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM');
}
function toIso_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/**
 * 明細を台帳へ upsert する。
 * @param {Spreadsheet} ss
 * @param {Array<Object>} txns 正規化済み明細
 * @param {string} yearMonth 対象月 'yyyy-MM'
 * @param {Array<string>} fetchedSources 今回取得したサービス（例 ['Stripe','Komoju']）
 */
function upsertLedger_(ss, txns, yearMonth, fetchedSources) {
  const sh = ensureSheetWithHeader_(ss, SHEETS.LEDGER, LEDGER_COLS);
  const keptCount = deleteRowsFor_(sh, LEDGER_COLS, yearMonth, fetchedSources);

  if (!txns.length) return;
  const rows = txns.map(function (t) {
    return [
      t.source, t.id, toIso_(t.date), yearMonth, t.kind, t.type,
      t.product, t.orderId, t.method, t.gross, t.fee, t.net,
      t.payoutId, t.payoutDate ? toIso_(t.payoutDate) : '',
    ];
  });
  // 行1が見出し、行2〜(1+keptCount)が残存データ。次の空き行から追記。
  sh.getRange(2 + keptCount, 1, rows.length, LEDGER_COLS.length).setValues(rows);
}

/** 入金(payout)を台帳へ upsert する */
function upsertPayoutLedger_(ss, payouts, yearMonth, fetchedSources) {
  const sh = ensureSheetWithHeader_(ss, SHEETS.PAYOUTS, PAYOUT_COLS);
  const keptCount = deleteRowsFor_(sh, PAYOUT_COLS, yearMonth, fetchedSources);

  if (!payouts.length) return;
  const rows = payouts.map(function (p) {
    return [
      p.source, p.payoutId, toIso_(p.arrivalDate), yearMonth,
      p.payoutAmount, p.calculatedNet, p.status,
    ];
  });
  sh.getRange(2 + keptCount, 1, rows.length, PAYOUT_COLS.length).setValues(rows);
}

/**
 * (yearMonth × source) が一致する行を削除し、残った行を上詰めで書き戻す。
 * @return {number} 残ったデータ行数
 */
function deleteRowsFor_(sh, cols, yearMonth, sources) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const srcIdx = cols.indexOf('source');
  const ymIdx = cols.indexOf('yearMonth');
  const data = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const srcSet = {};
  sources.forEach(function (s) { srcSet[s] = true; });

  // 対象（今回入れ直す月×サービス）以外を残す
  const keep = data.filter(function (row) {
    const isTarget = srcSet[row[srcIdx]] && String(row[ymIdx]) === yearMonth;
    return !isTarget;
  });
  // データ領域をいったん全消しして、残す行を上から詰め直す
  sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (keep.length) {
    sh.getRange(2, 1, keep.length, cols.length).setValues(keep);
  }
  return keep.length;
}

/** 明細台帳を丸ごと書き直す（既存データを消して txns で上書き）。 */
function rewriteLedger_(ss, txns) {
  const sh = ensureSheetWithHeader_(ss, SHEETS.LEDGER, LEDGER_COLS);
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, LEDGER_COLS.length).clearContent();
  if (!txns.length) return;
  const rows = txns.map(function (t) {
    return [
      t.source, t.id, toIso_(t.date), t.yearMonth || formatYm_(t.date), t.kind, t.type,
      t.product, t.orderId, t.method, t.gross, t.fee, t.net,
      t.payoutId, t.payoutDate ? toIso_(t.payoutDate) : '',
    ];
  });
  sh.getRange(2, 1, rows.length, LEDGER_COLS.length).setValues(rows);
}

/** 明細台帳を全件読み込み、txn オブジェクトの配列で返す */
function readLedger_(ss) {
  const sh = ss.getSheetByName(SHEETS.LEDGER);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, LEDGER_COLS.length).getValues();
  return data
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      const o = {};
      LEDGER_COLS.forEach(function (c, i) { o[c] = r[i]; });
      o.date = new Date(o.date);
      o.payoutDate = o.payoutDate ? new Date(o.payoutDate) : null;
      o.gross = Number(o.gross) || 0;
      o.fee = Number(o.fee) || 0;
      o.net = Number(o.net) || 0;
      return o;
    });
}

/** 入金台帳を全件読み込み */
function readPayoutLedger_(ss) {
  const sh = ss.getSheetByName(SHEETS.PAYOUTS);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, PAYOUT_COLS.length).getValues();
  return data
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      const o = {};
      PAYOUT_COLS.forEach(function (c, i) { o[c] = r[i]; });
      o.arrivalDate = new Date(o.arrivalDate);
      o.payoutAmount = Number(o.payoutAmount) || 0;
      o.calculatedNet = Number(o.calculatedNet) || 0;
      return o;
    });
}
