/**
 * ============================================================================
 * 売上レポート自動化 — 全コードまとめ版（このファイル1つを貼り付ければOK）
 * ============================================================================
 */


// ====================================================================
// 以下は Config.gs の内容
// ====================================================================
/**
 * Config.gs
 * -----------------------------------------------------------------------------
 * 設定値と、APIキー（機密情報）の保管・取得をまとめたモジュール。
 *
 * APIキーはコードに直書きせず、スクリプトプロパティ（Script Properties）に
 * 保存します。メニュー「売上レポート > ① APIキーを設定」から入力できます。
 */

/** シート名の定義（必要なら日本語名を変更してOK） */
const SHEETS = {
  ANNUAL: '年度サマリー',        // 年度ごとの Stripe/Komoju 合計
  BY_BUSINESS: '事業別サマリー',  // 年度ごと・事業ごとの入金
  BY_PRODUCT: '商品別売上',      // 年度ごと・商品別の集計
  BY_METHOD: '決済手段別',       // 年度ごと・決済手段別の集計
  RECONCILE: '入金照合',         // 入金額（振込）との照合・検算
  SUBMISSION: '提出用明細',      // 会社提出用に整えた明細（列を絞り見出しを日本語化）
  LEDGER: '明細DB',             // ★全取引を蓄積する台帳（元データ・年間で追記されていく）
  PAYOUTS: '入金DB',            // ★入金(payout)を蓄積する台帳
  MAPPING: '事業マッピング',      // キーワード→事業名 の対応表（ユーザーが編集）
  KOMOJU_ASSIGN: 'Komoju仕分け', // Komojuの手動タグ付け（注文コード→事業・商品名）
};

/** スクリプトプロパティのキー名 */
const PROP_KEYS = {
  STRIPE_SECRET: 'STRIPE_SECRET_KEY',   // 例: sk_live_xxx（読み取り専用の制限キー推奨）
  KOMOJU_SECRET: 'KOMOJU_SECRET_KEY',   // Komoju のシークレットキー
  KOMOJU_FEE_RATE: 'KOMOJU_FEE_RATE',   // Komoju の手数料率（例 "0.0365" = 3.65%）※純額の概算用
  FISCAL_START: 'FISCAL_YEAR_START_MONTH', // 年度の開始月（1〜12）。既定は 4（4月始まり）
  WIX_API_KEY: 'WIX_API_KEY',           // Wix APIキー（注文の商品名取得に使用）
  WIX_ACCOUNT_ID: 'WIX_ACCOUNT_ID',     // Wix アカウントID
  WIX_SITE_ID: 'WIX_SITE_ID',           // Wix サイトID
};

/** 通貨設定。日本円は補助単位なし（amount がそのまま円）。 */
const CURRENCY = {
  CODE: 'jpy',
  // JPY はゼロデシマル通貨（Stripe/Komoju の amount が円そのもの）。
  // USD 等を扱う場合はここを 100 にして按分ロジックを見直すこと。
  MINOR_UNIT_DIVISOR: 1,
};

/** スクリプトプロパティから値を取得（無ければ空文字） */
function getProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v == null ? '' : String(v).trim();
}

/** Stripe を使う設定になっているか */
function isStripeEnabled_() {
  return getProp_(PROP_KEYS.STRIPE_SECRET) !== '';
}

/** Komoju を使う設定になっているか */
function isKomojuEnabled_() {
  return getProp_(PROP_KEYS.KOMOJU_SECRET) !== '';
}

/** Komoju の手数料率（未設定なら 0） */
function getKomojuFeeRate_() {
  const raw = getProp_(PROP_KEYS.KOMOJU_FEE_RATE);
  const n = parseFloat(raw);
  return isFinite(n) && n >= 0 ? n : 0;
}

/** Wix 連携（商品名取得）が設定されているか */
function isWixEnabled_() {
  return getProp_(PROP_KEYS.WIX_API_KEY) !== '' && getProp_(PROP_KEYS.WIX_SITE_ID) !== '';
}


// ====================================================================
// 以下は Business.gs の内容
// ====================================================================
/**
 * Business.gs
 * -----------------------------------------------------------------------------
 * 年度（会計年度）の計算と、事業（ビジネス）への振り分けを担当。
 *
 * ■ 年度
 *   日本の会計年度に合わせ、既定は「4月始まり（4月〜翌3月）」。
 *   例: 2026年4月〜2027年3月 → 「2026年度」。
 *   開始月はスクリプトプロパティ FISCAL_YEAR_START_MONTH で変更可能（1〜12）。
 *   1 を設定すると暦年（1月〜12月）になります。
 *
 * ■ 事業への振り分け
 *   「事業マッピング」シート（キーワード | 事業名）で、取引をどの事業に
 *   割り当てるかを定義します。商品名・注文ID にキーワードが含まれれば、
 *   その事業に分類します（上の行が優先）。どれにも一致しなければ「未分類」。
 */

/** 年度の開始月（既定 4） */
function getFiscalStartMonth_() {
  const v = parseInt(getProp_(PROP_KEYS.FISCAL_START), 10);
  return (v >= 1 && v <= 12) ? v : 4;
}

/** 日付から年度（数値）を求める。例: 4月始まりなら 2027-02 → 2026 */
function fiscalYearOf_(date) {
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  return m >= getFiscalStartMonth_() ? y : y - 1;
}

/** 年度の表示ラベル。4月始まり等なら「2026年度」、暦年なら「2026年」 */
function fiscalYearLabel_(fy) {
  return getFiscalStartMonth_() === 1 ? (fy + '年') : (fy + '年度');
}

/** 年度の期間ラベル。例（4月始まり, fy=2026）→「2026年4月〜2027年3月」 */
function fiscalYearRangeLabel_(fy) {
  const s = getFiscalStartMonth_();
  const endMonth = s === 1 ? 12 : s - 1;
  const endYear = s === 1 ? fy : fy + 1;
  return fy + '年' + s + '月〜' + endYear + '年' + endMonth + '月';
}

/**
 * 年度内の「会計月の並び」を返す。
 * 4月始まりなら [4,5,...,12,1,2,3]。集計表の列順に使う。
 */
function fiscalMonthOrder_() {
  const s = getFiscalStartMonth_();
  const arr = [];
  for (let i = 0; i < 12; i++) arr.push(((s - 1 + i) % 12) + 1);
  return arr;
}

/** 事業マッピングシートを用意（無ければ見出しと記入例を作成） */
function ensureMappingSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.MAPPING);
  if (sh) return sh;
  sh = ss.insertSheet(SHEETS.MAPPING);
  sh.getRange(1, 1, 1, 2).setValues([['キーワード', '事業名']])
    .setFontWeight('bold').setBackground('#e8eef7');
  sh.getRange(2, 1, 3, 2).setValues([
    ['講座', 'オンライン講座事業'],
    ['書籍', '出版事業'],
    ['グッズ', '物販事業'],
  ]);
  sh.getRange(6, 1).setValue('※ 商品名・注文IDにキーワードが含まれる取引を、その事業へ分類します（上の行が優先）。')
    .setFontColor('#888888').setFontSize(9);
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 220);
  return sh;
}

/** マッピングシートから振り分けルールを読み込む */
function loadBusinessRules_(ss) {
  const sh = ensureMappingSheet_(ss);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, 2).getValues();
  const rules = [];
  values.forEach(function (row) {
    const kw = String(row[0] || '').trim();
    const biz = String(row[1] || '').trim();
    if (kw && biz) rules.push({ keyword: kw, business: biz });
  });
  return rules;
}

/** 1取引を事業へ分類（一致しなければ「未分類」） */
function classifyBusiness_(txn, rules) {
  const hay = (String(txn.product || '') + ' ' + String(txn.orderId || '')).toLowerCase();
  for (let i = 0; i < rules.length; i++) {
    if (hay.indexOf(rules[i].keyword.toLowerCase()) !== -1) return rules[i].business;
  }
  return '未分類';
}

// ---------------------------------------------------------------------------
// Komoju の手動タグ付け（注文コード → 事業・商品名 を人が割り当てる）
// ---------------------------------------------------------------------------

const KOMOJU_ASSIGN_COLS = ['注文コード', '日付', '金額', '決済手段', '事業', '商品名'];

/** 仕分けシートを用意（無ければ見出しを作成） */
function ensureKomojuAssignSheet_(ss) {
  let sh = ss.getSheetByName(SHEETS.KOMOJU_ASSIGN);
  if (sh) return sh;
  sh = ss.insertSheet(SHEETS.KOMOJU_ASSIGN);
  sh.getRange(1, 1, 1, KOMOJU_ASSIGN_COLS.length).setValues([KOMOJU_ASSIGN_COLS])
    .setFontWeight('bold').setBackground('#e8eef7');
  sh.setFrozenRows(1);
  sh.getRange(1, 8).setValue('← 「事業」列を選ぶだけでOK（商品名は任意）。選んだ内容は記憶され、翌月は新規分だけ増えます。')
    .setFontColor('#888888');
  sh.setColumnWidth(1, 300);
  return sh;
}

/**
 * 台帳のKomoju注文コードのうち、仕分けシートに未登録のものを追記する。
 * 既存の割り当て（事業・商品名）は保持。
 * @return {{added:number, blank:number}}
 */
function refreshKomojuAssign_(ss) {
  const sh = ensureKomojuAssignSheet_(ss);
  const last = sh.getLastRow();
  const existing = {};
  if (last >= 2) {
    const codes = sh.getRange(2, 1, last - 1, 1).getValues();
    codes.forEach(function (r) { if (r[0]) existing[String(r[0])] = true; });
  }

  // 台帳のKomoju行から、コード単位で代表情報を集める
  const txns = readLedger_(ss).filter(function (t) { return t.source === 'Komoju' && t.kind === 'sale'; });
  const newRows = [];
  const seen = {};
  // 商品名がまだ記号（UUID）のまま＝自動補完できなかった行だけを対象にする
  const looksLikeCode = function (s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(String(s || '')); };
  txns.forEach(function (t) {
    const code = String(t.orderId || t.product || '');
    if (!code || existing[code] || seen[code]) return;
    if (!looksLikeCode(t.product)) return; // 既に商品名が付いている行は仕分け不要
    seen[code] = true;
    newRows.push([
      code,
      Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy/MM/dd'),
      t.gross,
      t.method,
      '', '',
    ]);
  });
  if (newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, KOMOJU_ASSIGN_COLS.length).setValues(newRows);
    sh.getRange(2, 3, sh.getLastRow() - 1, 1).setNumberFormat('#,##0" 円"');
  }

  // 「事業」列にプルダウン（事業マッピングの事業名から）
  applyBusinessDropdown_(ss, sh);

  // 空欄（未割り当て）の数を数える
  let blank = 0;
  const lr = sh.getLastRow();
  if (lr >= 2) {
    const biz = sh.getRange(2, 5, lr - 1, 1).getValues();
    biz.forEach(function (r) { if (!String(r[0]).trim()) blank++; });
  }
  return { added: newRows.length, blank: blank };
}

/** 「事業」列にプルダウン（事業マッピングの事業名一覧）を設定 */
function applyBusinessDropdown_(ss, sh) {
  const rules = loadBusinessRules_(ss);
  const names = {};
  rules.forEach(function (r) { names[r.business] = true; });
  const list = Object.keys(names);
  const lr = sh.getLastRow();
  if (!list.length || lr < 2) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
  sh.getRange(2, 5, lr - 1, 1).setDataValidation(rule);
}

/** 仕分けシートを読み、コード→{business, product} のマップを返す */
function loadKomojuAssign_(ss) {
  const sh = ss.getSheetByName(SHEETS.KOMOJU_ASSIGN);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, KOMOJU_ASSIGN_COLS.length).getValues();
  rows.forEach(function (r) {
    const code = String(r[0] || '').trim();
    const business = String(r[4] || '').trim();
    const product = String(r[5] || '').trim();
    if (code && (business || product)) map[code] = { business: business, product: product };
  });
  return map;
}


// ====================================================================
// 以下は Ledger.gs の内容
// ====================================================================
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


// ====================================================================
// 以下は Http.gs の内容
// ====================================================================
/**
 * Http.gs
 * -----------------------------------------------------------------------------
 * HTTP まわりの共通ユーティリティ。
 */

/**
 * key=value の配列からクエリ文字列を作る。
 * ブラケット記法（例: ['arrival_date[gte]', 1700000000]）や
 * 同名キーの重複（例: expand[]）にも対応するため、[key, value] の配列で受け取る。
 *
 * @param {Array<[string, (string|number)]>} pairs
 * @return {string} 例: "limit=100&arrival_date%5Bgte%5D=1700000000"
 */
function buildQuery_(pairs) {
  return pairs
    .filter(function (p) { return p[1] !== undefined && p[1] !== null && p[1] !== ''; })
    .map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    })
    .join('&');
}

/**
 * GET して JSON を返す。エラー時は分かりやすい例外を投げる。
 *
 * @param {string} url
 * @param {Object} headers 追加ヘッダ（Authorization など）
 * @return {Object} パース済み JSON
 */
function httpGetJson_(url, headers) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: headers || {},
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ' : ' + url + '\n' + body.slice(0, 500));
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('JSON パース失敗: ' + url + '\n' + body.slice(0, 300));
  }
}


// ====================================================================
// 以下は Stripe.gs の内容
// ====================================================================
/**
 * Stripe.gs
 * -----------------------------------------------------------------------------
 * Stripe API クライアント。
 *
 * ポイント:
 *   - 「入金（payout）」ごとに、その入金へ含まれる取引（balance transaction）を取得し、
 *     売上・手数料・返金・純額（net）を集計できるようにする。
 *   - Stripe は「どの取引がどの入金に含まれるか」を balance_transaction.payout で
 *     ひも付けているため、手作業で一番面倒な部分を自動化できる。
 *
 * 参考: https://stripe.com/docs/api/payouts /balance_transactions
 */

const STRIPE_BASE = 'https://api.stripe.com/v1';

/** Stripe 認証ヘッダ */
function stripeHeaders_() {
  const key = getProp_(PROP_KEYS.STRIPE_SECRET);
  if (!key) throw new Error('Stripe のシークレットキーが未設定です。メニューから設定してください。');
  return { Authorization: 'Bearer ' + key };
}

/**
 * 指定期間に着金した payout（入金）一覧を取得。
 * @param {number} gteUnix arrival_date の下限（UNIX秒, 含む）
 * @param {number} lteUnix arrival_date の上限（UNIX秒, 含む）
 * @return {Array<Object>} payout オブジェクトの配列
 */
function stripeListPayouts_(gteUnix, lteUnix) {
  const out = [];
  let startingAfter = '';
  do {
    const q = buildQuery_([
      ['limit', 100],
      ['arrival_date[gte]', gteUnix],
      ['arrival_date[lte]', lteUnix],
      ['starting_after', startingAfter],
    ]);
    const json = httpGetJson_(STRIPE_BASE + '/payouts?' + q, stripeHeaders_());
    (json.data || []).forEach(function (p) { out.push(p); });
    if (json.has_more && json.data.length) {
      startingAfter = json.data[json.data.length - 1].id;
    } else {
      startingAfter = '';
    }
  } while (startingAfter);
  return out;
}

/**
 * ある payout に含まれる balance transaction を全件取得（source を展開）。
 * @param {string} payoutId
 * @return {Array<Object>}
 */
function stripeListBalanceTransactionsForPayout_(payoutId) {
  const out = [];
  let startingAfter = '';
  do {
    const q = buildQuery_([
      ['limit', 100],
      ['payout', payoutId],
      ['expand[]', 'data.source'],
      ['starting_after', startingAfter],
    ]);
    const json = httpGetJson_(STRIPE_BASE + '/balance_transactions?' + q, stripeHeaders_());
    (json.data || []).forEach(function (t) { out.push(t); });
    if (json.has_more && json.data.length) {
      startingAfter = json.data[json.data.length - 1].id;
    } else {
      startingAfter = '';
    }
  } while (startingAfter);
  return out;
}

/**
 * 期間内の Stripe 入金を取得し、正規化した取引明細（NormalizedTxn）へ変換する。
 * 返り値には各明細と、payout 単位の照合情報を含む。
 *
 * @param {number} gteUnix
 * @param {number} lteUnix
 * @return {{ txns: Array<Object>, payouts: Array<Object> }}
 */
function stripeCollect_(gteUnix, lteUnix) {
  const txns = [];
  const payoutSummaries = [];
  const payouts = stripeListPayouts_(gteUnix, lteUnix);

  payouts.forEach(function (payout) {
    const arrival = new Date(payout.arrival_date * 1000);
    const bts = stripeListBalanceTransactionsForPayout_(payout.id);

    let sumNet = 0;
    bts.forEach(function (bt) {
      const rec = stripeNormalizeTxn_(bt, payout, arrival);
      if (rec) {
        txns.push(rec);
        sumNet += rec.net;
      }
    });

    payoutSummaries.push({
      source: 'Stripe',
      payoutId: payout.id,
      arrivalDate: arrival,
      // payout.amount は「実際に振り込まれた金額」（純額）
      payoutAmount: toYen_(payout.amount),
      // 明細の net 合計。理論上 payout.amount と一致するはず。
      calculatedNet: toYen_(sumNet * CURRENCY.MINOR_UNIT_DIVISOR),
      status: payout.status,
    });
  });

  return { txns: txns, payouts: payoutSummaries };
}

/**
 * balance transaction を共通フォーマットへ正規化。
 * 売上/返金/調整などを対象にし、payout 自体の行は除外する。
 */
function stripeNormalizeTxn_(bt, payout, arrivalDate) {
  const type = bt.type;
  // payout 行（入金そのもの）は明細集計から除外
  if (type === 'payout' || type === 'payout_cancel' || type === 'payout_failure') return null;

  const source = bt.source || {};
  const created = new Date(bt.created * 1000);

  // 売上か返金かの区分
  let kind;
  if (type === 'charge' || type === 'payment') kind = 'sale';
  else if (type === 'refund' || type === 'payment_refund' || type === 'refund_failure') kind = 'refund';
  else kind = 'other'; // adjustment, stripe_fee, application_fee など

  return {
    source: 'Stripe',
    id: bt.id,
    date: created,
    kind: kind,
    type: type,
    gross: toYen_(bt.amount),         // 手数料込みの取引額（返金は負）
    fee: toYen_(bt.fee),              // Stripe 手数料
    net: toYen_(bt.net),             // 純額 = gross - fee
    currency: (bt.currency || CURRENCY.CODE).toLowerCase(),
    product: stripeProductLabel_(source),
    orderId: stripeOrderId_(source),
    method: stripeMethodLabel_(source),
    payoutId: payout.id,
    payoutDate: arrivalDate,
  };
}

/** 商品/注文の表示名を推定（Wix は description に注文番号が入ることが多い） */
function stripeProductLabel_(source) {
  const md = source.metadata || {};
  return (
    md.product ||
    md.product_name ||
    md.item_name ||
    source.description ||
    md.order_id ||
    md.order ||
    '(商品名なし)'
  );
}

/** 注文ID（Wix 注文とのひも付け用）を推定 */
function stripeOrderId_(source) {
  const md = source.metadata || {};
  return md.order_id || md.order || md.wix_order_id || '';
}

/** 決済手段のラベル（例: "カード(visa)"） */
function stripeMethodLabel_(source) {
  const d = source.payment_method_details || {};
  const t = d.type || '';
  if (t === 'card' && d.card && d.card.brand) return 'カード(' + d.card.brand + ')';
  const map = {
    card: 'カード',
    konbini: 'コンビニ',
    bank_transfer: '銀行振込',
    customer_balance: '銀行振込',
    link: 'Link',
  };
  return map[t] || (t || '(不明)');
}

/** Stripe 金額（JPY はそのまま円） */
function toYen_(amount) {
  return Math.round((amount || 0) / CURRENCY.MINOR_UNIT_DIVISOR);
}


// ====================================================================
// 以下は Komoju.gs の内容
// ====================================================================
/**
 * Komoju.gs
 * -----------------------------------------------------------------------------
 * Komoju API クライアント。
 *
 * Komoju の /payments から、期間内の決済（売上・返金・決済手段）を取得する。
 *
 * 注意（重要）:
 *   - Komoju の payment オブジェクトには「加盟店手数料」が常に含まれるとは限らない。
 *     そのため純額（net）は KOMOJU_FEE_RATE（設定した手数料率）による "概算" とする。
 *     正確な手数料・入金額は Komoju の入金明細（精算レポート）で確定するため、
 *     入金照合シートでは「概算」と明示する。実データに合わせて後で調整可能。
 *
 * 参考: https://doc.komoju.com/reference (Payments API)
 */

const KOMOJU_BASE = 'https://komoju.com/api/v1';

/** Komoju 認証ヘッダ（Basic 認証: シークレットキーをユーザー名、パスワード空） */
function komojuHeaders_() {
  const key = getProp_(PROP_KEYS.KOMOJU_SECRET);
  if (!key) throw new Error('Komoju のシークレットキーが未設定です。メニューから設定してください。');
  return { Authorization: 'Basic ' + Utilities.base64Encode(key + ':') };
}

/** Komojuの精算（入金）を全件取得。 */
function komojuListAllSettlements_() {
  const out = [];
  let page = 1;
  while (page <= 100) {
    const json = httpGetJson_(KOMOJU_BASE + '/settlements?' + buildQuery_([['page', page], ['per_page', 100]]), komojuHeaders_());
    const data = json.data || [];
    data.forEach(function (s) { out.push(s); });
    if (!data.length) break;
    if (json.last_page && page >= json.last_page) break;
    if (data.length < (json.per_page || 100)) break;
    page++;
  }
  return out;
}

/** Komojuの精算を、入金台帳レコード形式へ変換（実際の振込額）。 */
function komojuSettlementRecord_(s) {
  const cutoff = s.cutoff_time ? new Date(s.cutoff_time) : (s.created_at ? new Date(s.created_at) : null);
  const arrival = s.created_at ? new Date(s.created_at) : cutoff;
  return {
    source: 'Komoju',
    payoutId: s.reference || s.id,
    arrivalDate: arrival || new Date(),
    yearMonth: cutoff ? Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM') : '',
    payoutAmount: parseInt(s.amount, 10) || 0,   // 実際に振り込まれた額（純額）
    calculatedNet: 0,                            // 呼び出し側でその月のKomoju純額合計を入れる
    status: s.status || '',
  };
}

/**
 * 期間内の Komoju 決済を取得して正規化。
 * created_at で period に入るものだけを対象にする（クライアント側フィルタ）。
 *
 * @param {Date} from
 * @param {Date} to
 * @return {{ txns: Array<Object> }}
 */
function komojuCollect_(from, to) {
  const txns = [];
  const feeRate = getKomojuFeeRate_();
  const perPage = 100;

  // 並び順に依存せず、全ページを走査して period 内の決済だけ拾う。
  // （Komoju の返す並び順が新しい順とは限らないため、途中で打ち切らない）
  let page = 1, fetched = 0, total = null;
  while (page <= 500) {
    const q = buildQuery_([['per_page', perPage], ['limit', perPage], ['page', page]]);
    const json = httpGetJson_(KOMOJU_BASE + '/payments?' + q, komojuHeaders_());
    const data = json.data || [];
    if (!data.length) break;

    data.forEach(function (p) {
      const created = komojuParseDate_(p.created_at || p.captured_at);
      if (created && created.getTime() >= from.getTime() && created.getTime() <= to.getTime()) {
        pushKomojuTxns_(txns, p, created, feeRate);
      }
    });

    fetched += data.length;
    if (typeof json.total === 'number') total = json.total;
    const respPer = (typeof json.per_page === 'number' && json.per_page > 0) ? json.per_page : data.length;
    if (total != null && fetched >= total) break; // 全件取得しきった
    if (data.length < respPer) break;             // 最終ページ
    page++;
  }

  return { txns: txns };
}

/** 1つの Komoju payment を、売上（+必要なら返金）明細に変換して push */
function pushKomojuTxns_(out, p, created, feeRate) {
  // 未成立・失敗・キャンセル等（お金が動いていないもの）だけ除外し、
  // それ以外（captured / authorized / refunded など）は売上として扱う。
  const status = String(p.status || '').toLowerCase();
  const DEAD = ['failed', 'cancelled', 'canceled', 'expired', 'pending'];
  if (DEAD.indexOf(status) !== -1 && !(p.amount_refunded > 0)) {
    return;
  }

  const gross = komojuYen_(p.amount);
  const refunded = komojuYen_(p.amount_refunded || 0);
  const estFee = Math.round(gross * feeRate);
  const method = komojuMethodLabel_(p.payment_details || {});
  const product = komojuProductLabel_(p);
  const orderId = p.external_order_num || '';

  // 売上行
  out.push({
    source: 'Komoju',
    id: p.id,
    date: created,
    kind: 'sale',
    type: 'payment',
    gross: gross,
    fee: estFee,               // ★概算（KOMOJU_FEE_RATE による）
    net: gross - estFee,       // ★概算
    currency: (p.currency || CURRENCY.CODE).toLowerCase(),
    product: product,
    orderId: orderId,
    method: method,
    payoutId: 'komoju',        // Komoju は payout 単位のひも付けを別途要確認
    payoutDate: created,
  });

  // 返金がある場合は返金行も追加（売上から差し引くため負値）
  if (refunded > 0) {
    out.push({
      source: 'Komoju',
      id: p.id + ':refund',
      date: created,
      kind: 'refund',
      type: 'refund',
      gross: -refunded,
      fee: 0,
      net: -refunded,
      currency: (p.currency || CURRENCY.CODE).toLowerCase(),
      product: product,
      orderId: orderId,
      method: method,
      payoutId: 'komoju',
      payoutDate: created,
    });
  }
}

/** 決済手段ラベル */
function komojuMethodLabel_(details) {
  const t = details.type || '';
  const map = {
    credit_card: 'カード',
    konbini: 'コンビニ',
    bank_transfer: '銀行振込',
    pay_easy: 'ペイジー',
    paypay: 'PayPay',
    linepay: 'LINE Pay',
    merpay: 'メルペイ',
    web_money: 'WebMoney',
    bit_cash: 'BitCash',
  };
  if (t === 'credit_card' && details.brand) return 'カード(' + details.brand + ')';
  return map[t] || (t || '(不明)');
}

/** 商品/注文名の推定 */
function komojuProductLabel_(p) {
  const md = p.metadata || {};
  return (
    md.product ||
    md.product_name ||
    md.item_name ||
    p.description ||
    p.external_order_num ||
    '(商品名なし)'
  );
}

/** Komoju 金額（JPY はそのまま円） */
function komojuYen_(amount) {
  return Math.round((amount || 0) / CURRENCY.MINOR_UNIT_DIVISOR);
}

/** Komoju の日付文字列を Date に */
function komojuParseDate_(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}


// ====================================================================
// 以下は Wix.gs の内容
// ====================================================================
/**
 * Wix.gs
 * -----------------------------------------------------------------------------
 * Wix「支払い(Payments)」トランザクション API クライアント。
 *
 * 目的：Komoju の決済は商品名が注文コードしか入らないため、Wixの支払いデータ
 *       （/payments/v2/transactions）から本当の商品名を取得して補う。
 *       支払いデータには 金額・日付・商品名・決済代行ID が揃っている。
 *
 * 突き合わせ：決済代行ID（providerTransactionId）で厳密一致、無ければ
 *            金額＋日付（Stripe以外・同額の商品名が一意な場合）で一致。
 *
 * 認証：アカウントのAPIキー ＋ サイトID ＋ アカウントID をヘッダで渡す。
 */

const WIX_BASE = 'https://www.wixapis.com';

/** Wix 認証ヘッダ */
function wixHeaders_() {
  const key = getProp_(PROP_KEYS.WIX_API_KEY);
  const site = getProp_(PROP_KEYS.WIX_SITE_ID);
  const account = getProp_(PROP_KEYS.WIX_ACCOUNT_ID);
  if (!key || !site) throw new Error('Wix の APIキー / サイトID が未設定です。「①」から設定してください。');
  const h = {
    'Authorization': key,
    'wix-site-id': site,
    'Content-Type': 'application/json',
  };
  if (account) h['wix-account-id'] = account;
  return h;
}

/** GET して {status, text} を返す（例外にしない）。 */
function wixGet_(path) {
  try {
    const res = UrlFetchApp.fetch(WIX_BASE + path, {
      method: 'get', headers: wixHeaders_(), muteHttpExceptions: true,
    });
    return { status: res.getResponseCode(), text: res.getContentText() };
  } catch (e) {
    return { status: -1, text: String(e) };
  }
}

/**
 * 支払いトランザクションを新しい順に取得し、fromDate より古くなったら停止。
 * ページ送りは offset 方式（?limit=100&offset=N）。
 */
function wixListTransactionsUntil_(fromDate) {
  const out = [];
  const limit = 100;
  let offset = 0;
  let guard = 0;
  while (guard < 300) {
    guard++;
    const r = wixGet_('/payments/v2/transactions?limit=' + limit + '&offset=' + offset);
    if (r.status !== 200) break;
    let j;
    try { j = JSON.parse(r.text); } catch (e) { break; }
    const txs = j.transactions || [];
    if (!txs.length) break;
    txs.forEach(function (t) { out.push(t); });

    const last = txs[txs.length - 1];
    const lastDate = last.createdAt ? new Date(last.createdAt) : null;
    if (lastDate && lastDate.getTime() < fromDate.getTime()) break;
    if (txs.length < limit) break;

    offset += limit;
    const total = j.pagination && j.pagination.total;
    if (typeof total === 'number' && offset >= total) break;
  }
  return out;
}

/** 支払いトランザクションから商品名ラベルを作る */
function wixTxProductName_(tx) {
  const items = (tx.order && tx.order.description && tx.order.description.items) || [];
  const names = items.map(function (it) { return it.name; }).filter(function (s) { return s; });
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return names[0] + ' 他' + (names.length - 1) + '点';
}

function wixIsStripeTx_(tx) {
  return String(tx.provider || '').toLowerCase().indexOf('stripe') !== -1;
}

/**
 * 支払いトランザクションから突き合わせ用の索引を1回だけ作る。
 * @param {Date} fromDate ここより新しい取引まで取得
 * @return {{byProv:Object, nonStripe:Array}}
 */
function wixBuildTxIndex_(fromDate) {
  const wtx = wixListTransactionsUntil_(fromDate);
  const byProv = {};      // providerTransactionId -> 商品名（全provider）
  const nonStripe = [];   // Stripe以外の取引（金額＋日付で突き合わせる候補）
  wtx.forEach(function (w) {
    const name = wixTxProductName_(w);
    if (!name) return;
    if (w.providerTransactionId) byProv[String(w.providerTransactionId)] = name;
    if (!wixIsStripeTx_(w)) {
      nonStripe.push({
        amt: w.amount ? Math.round(w.amount.amount) : null,
        date: w.createdAt ? new Date(w.createdAt) : null,
        name: name,
      });
    }
  });
  return { byProv: byProv, nonStripe: nonStripe };
}

/**
 * 事前に作った索引を使って Komoju 明細に商品名を付与する。
 * @return {{filled:number, byId:number, byAmt:number, target:number}}
 */
function wixApplyKomojuIndex_(txns, index) {
  const stats = { filled: 0, byId: 0, byAmt: 0, target: 0 };
  if (!index) return stats;
  const byProv = index.byProv || {};
  const nonStripe = index.nonStripe || [];
  const DAY = 86400000;
  const ymd = function (d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); };
  txns.forEach(function (t) {
    if (t.source !== 'Komoju') return;
    stats.target++;
    // ① 決済代行ID（Komoju決済ID）で厳密一致
    let name = byProv[String(t.id)];
    let via = name ? 'id' : '';
    if (!name) {
      const amt = Math.round(t.gross);
      const tYmd = ymd(t.date);
      // ② 同じ金額・同じ日付で照合。商品名が一意なら採用
      const sameDay = nonStripe.filter(function (w) {
        return w.amt === amt && w.date && ymd(w.date) === tYmd;
      }).map(function (w) { return w.name; });
      if (sameDay.length && allSame_(sameDay)) { name = sameDay[0]; via = 'amt'; }
      // ③ ダメなら同じ金額・±4日（コンビニの入金日ズレに対応）
      if (!name) {
        const near = nonStripe.filter(function (w) {
          return w.amt === amt && w.date && Math.abs(w.date.getTime() - t.date.getTime()) <= 4 * DAY;
        }).map(function (w) { return w.name; });
        if (near.length && allSame_(near)) { name = near[0]; via = 'amt'; }
      }
    }
    if (name) {
      if (!t.orderId) t.orderId = String(t.id);
      t.product = name;
      stats.filled++;
      if (via === 'id') stats.byId++; else stats.byAmt++;
    }
  });
  return stats;
}

/**
 * Komoju 明細の商品名を、Wixの支払いデータから補完する。
 * @return {{filled:number, byId:number, byAmt:number, target:number}}
 */
function wixEnrichKomojuTxns_(txns) {
  const empty = { filled: 0, byId: 0, byAmt: 0, target: 0 };
  if (!isWixEnabled_()) return empty;
  let minDate = null;
  txns.forEach(function (t) {
    if (t.source === 'Komoju' && t.date && (!minDate || t.date.getTime() < minDate.getTime())) minDate = t.date;
  });
  if (!minDate) return empty;
  const index = wixBuildTxIndex_(new Date(minDate.getTime() - 4 * 86400000));
  return wixApplyKomojuIndex_(txns, index);
}

function allSame_(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[0]) return false;
  return true;
}


// ====================================================================
// 以下は Aggregate.gs の内容
// ====================================================================
/**
 * Aggregate.gs
 * -----------------------------------------------------------------------------
 * 台帳（全取引）から、年度ごと・事業ごと・決済ごとの集計を作る。
 *
 * 生成する集計:
 *   1. annual    : 年度ごとの Stripe/Komoju 合計（＋月別推移）
 *   2. business  : 年度ごと・事業ごとの入金
 *   3. byProduct : 年度ごと・商品別
 *   4. byMethod  : 年度ごと・決済手段別
 *   5. reconcile : 入金(payout)との照合
 */

/** 空の集計オブジェクト */
function emptyAgg_() {
  return { gross: 0, refund: 0, fee: 0, net: 0, count: 0 };
}
function addTxn_(acc, t) {
  if (t.kind === 'sale') { acc.gross += t.gross; acc.count += 1; }
  else if (t.kind === 'refund') { acc.refund += -t.gross; } // gross は負値
  acc.fee += t.fee;
  acc.net += t.net;
}

/**
 * 台帳の全取引 + ルール + 入金台帳から、全レポート用データを作る。
 * @param {Array<Object>} txns
 * @param {Array<Object>} rules 事業振り分けルール
 * @param {Array<Object>} payouts 入金台帳
 * @return {Object}
 */
function buildReports_(txns, rules, payouts, komojuAssign) {
  const assign = komojuAssign || {};
  // 各取引に年度と事業を付与
  txns.forEach(function (t) {
    t.fy = fiscalYearOf_(t.date);
    // Komojuの手動タグ付けがあれば優先（商品名も上書き）
    const a = t.source === 'Komoju' ? assign[String(t.orderId || t.product || '')] : null;
    if (a && a.product) t.product = a.product;
    t.business = (a && a.business) ? a.business : classifyBusiness_(t, rules);
  });

  const fySet = {};
  txns.forEach(function (t) { fySet[t.fy] = true; });
  const fyList = Object.keys(fySet).map(Number).sort(function (a, b) { return b - a; }); // 新しい年度が上

  return {
    fyList: fyList,
    annual: buildAnnual_(txns, fyList),
    business: buildBusiness_(txns, fyList),
    byProduct: buildByKey_(txns, fyList, function (t) { return t.source + ' / ' + t.product; }, 'product'),
    byMethod: buildByKey_(txns, fyList, function (t) { return t.source + ' / ' + t.method; }, 'method'),
    reconcile: payouts || [],
  };
}

/** 年度 × サービス（Stripe/Komoju）の合計＋会計月別の純額推移 */
function buildAnnual_(txns, fyList) {
  const out = {};
  fyList.forEach(function (fy) {
    out[fy] = {
      bySource: {},                 // { Stripe: agg, Komoju: agg }
      total: emptyAgg_(),
      monthly: {},                  // { source: { month: net } }
    };
  });
  txns.forEach(function (t) {
    const b = out[t.fy];
    if (!b.bySource[t.source]) b.bySource[t.source] = emptyAgg_();
    addTxn_(b.bySource[t.source], t);
    addTxn_(b.total, t);
    if (!b.monthly[t.source]) b.monthly[t.source] = {};
    const m = t.date.getMonth() + 1;
    b.monthly[t.source][m] = (b.monthly[t.source][m] || 0) + t.net;
  });
  return out;
}

/** 年度 × 事業 の入金（純額）。サービス別の内訳も持つ */
function buildBusiness_(txns, fyList) {
  const out = {};
  fyList.forEach(function (fy) { out[fy] = {}; });
  txns.forEach(function (t) {
    const byBiz = out[t.fy];
    if (!byBiz[t.business]) {
      byBiz[t.business] = { total: emptyAgg_(), bySource: {} };
    }
    const rec = byBiz[t.business];
    addTxn_(rec.total, t);
    if (!rec.bySource[t.source]) rec.bySource[t.source] = emptyAgg_();
    addTxn_(rec.bySource[t.source], t);
  });
  return out;
}

/** 年度 × 任意キー（商品 or 決済手段）の集計 */
function buildByKey_(txns, fyList, keyFn, labelField) {
  const out = {};
  fyList.forEach(function (fy) { out[fy] = {}; });
  txns.forEach(function (t) {
    if (t.kind === 'other') return; // 手数料調整など（商品・決済手段ではない）は除外
    const map = out[t.fy];
    const key = keyFn(t);
    if (!map[key]) {
      map[key] = { source: t.source, label: t[labelField], agg: emptyAgg_(), biz: {} };
    }
    addTxn_(map[key].agg, t);
    if (t.business) map[key].biz[t.business] = true;
  });
  // 各年度を配列（売上降順）に整形
  const arr = {};
  fyList.forEach(function (fy) {
    arr[fy] = Object.keys(out[fy])
      .map(function (k) {
        const g = out[fy][k];
        g.business = Object.keys(g.biz).join(' / ');
        return g;
      })
      .sort(function (a, b) { return b.agg.gross - a.agg.gross; });
  });
  return arr;
}


// ====================================================================
// 以下は Report.gs の内容
// ====================================================================
/**
 * Report.gs
 * -----------------------------------------------------------------------------
 * 集計結果をスプレッドシートへ書き出す。すべて年度ごとにブロック分けして表示。
 */

const YEN_FMT = '#,##0" 円"';

/** サービスの表示順（Stripe→Komoju→その他） */
function sourceOrder_(sources) {
  const pref = { 'Stripe': 0, 'Komoju': 1 };
  return sources.slice().sort(function (a, b) {
    const pa = (a in pref) ? pref[a] : 99;
    const pb = (b in pref) ? pref[b] : 99;
    return pa - pb || String(a).localeCompare(String(b));
  });
}

function prepSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  return sh;
}

/** 全レポートを書き出す */
function writeAllReports_(ss, reports) {
  writeAnnualSheet_(ss, reports);
  writeBusinessSheet_(ss, reports);
  writeProductSheet_(ss, reports);
  writeMethodSheet_(ss, reports);
  writeReconcileSheet_(ss, reports.reconcile);
}

/** === 年度サマリー === */
function writeAnnualSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.ANNUAL);
  let r = 1;
  sh.getRange(r++, 1).setValue('年度サマリー（Stripe / Komoju の年間合計）')
    .setFontWeight('bold').setFontSize(14);
  sh.getRange(r++, 1).setValue('更新：' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  r++;

  if (!reports.fyList.length) {
    sh.getRange(r, 1).setValue('データがありません。月次レポートを実行すると台帳に蓄積されます。');
    return;
  }

  reports.fyList.forEach(function (fy) {
    const a = reports.annual[fy];

    sh.getRange(r, 1).setValue('■ ' + fiscalYearLabel_(fy) + '（' + fiscalYearRangeLabel_(fy) + '）')
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    r++;

    // 合計テーブル
    const header = ['決済', '総売上', '返金', '手数料', '純額（入金相当）', '販売件数'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const sources = sourceOrder_(Object.keys(a.bySource));
    const rows = [];
    sources.forEach(function (s) {
      const g = a.bySource[s];
      rows.push([s, g.gross, g.refund, g.fee, g.net, g.count]);
    });
    rows.push(['合計', a.total.gross, a.total.refund, a.total.fee, a.total.net, a.total.count]);
    sh.getRange(r, 1, rows.length, header.length).setValues(rows);
    sh.getRange(r, 2, rows.length, 4).setNumberFormat(YEN_FMT);
    sh.getRange(r + rows.length - 1, 1, 1, header.length).setFontWeight('bold').setBackground('#f2f6fc');
    r += rows.length + 1;

    // 月別推移（純額）
    const months = fiscalMonthOrder_();
    const mHeader = ['会計月'].concat(sources).concat(['合計']);
    sh.getRange(r, 1, 1, mHeader.length).setValues([mHeader]).setFontWeight('bold').setBackground('#eef7ee');
    r++;
    const mRows = months.map(function (m) {
      let total = 0;
      const row = [m + '月'];
      sources.forEach(function (s) {
        const v = (a.monthly[s] && a.monthly[s][m]) ? a.monthly[s][m] : 0;
        total += v;
        row.push(v);
      });
      row.push(total);
      return row;
    });
    sh.getRange(r, 1, mRows.length, mHeader.length).setValues(mRows);
    sh.getRange(r, 2, mRows.length, mHeader.length - 1).setNumberFormat(YEN_FMT);
    r += mRows.length + 2;
  });

  autoSize_(sh, 7);
}

/** === 事業別サマリー === */
function writeBusinessSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_BUSINESS);
  let r = 1;
  sh.getRange(r++, 1).setValue('事業別サマリー（各事業の入金）')
    .setFontWeight('bold').setFontSize(14);
  sh.getRange(r++, 1).setValue('「入金合計（純額）」＝手数料・返金を差し引いた、実際に入ってくる額です。');
  r++;

  if (!reports.fyList.length) {
    sh.getRange(r, 1).setValue('データがありません。');
    return;
  }

  reports.fyList.forEach(function (fy) {
    const byBiz = reports.business[fy];
    sh.getRange(r, 1).setValue('■ ' + fiscalYearLabel_(fy) + '（' + fiscalYearRangeLabel_(fy) + '）')
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    r++;

    const header = ['事業', 'Stripe入金', 'Komoju入金', '入金合計（純額）', '売上総額', '返金', '手数料'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;

    const bizNames = Object.keys(byBiz).sort(function (x, y) {
      return byBiz[y].total.net - byBiz[x].total.net;
    });
    const totals = { stripe: 0, komoju: 0, net: 0, gross: 0, refund: 0, fee: 0 };
    const rows = bizNames.map(function (name) {
      const rec = byBiz[name];
      const stripeNet = rec.bySource['Stripe'] ? rec.bySource['Stripe'].net : 0;
      const komojuNet = rec.bySource['Komoju'] ? rec.bySource['Komoju'].net : 0;
      totals.stripe += stripeNet; totals.komoju += komojuNet;
      totals.net += rec.total.net; totals.gross += rec.total.gross;
      totals.refund += rec.total.refund; totals.fee += rec.total.fee;
      return [name, stripeNet, komojuNet, rec.total.net, rec.total.gross, rec.total.refund, rec.total.fee];
    });
    rows.push(['合計', totals.stripe, totals.komoju, totals.net, totals.gross, totals.refund, totals.fee]);
    sh.getRange(r, 1, rows.length, header.length).setValues(rows);
    sh.getRange(r, 2, rows.length, 6).setNumberFormat(YEN_FMT);
    sh.getRange(r + rows.length - 1, 1, 1, header.length).setFontWeight('bold').setBackground('#f2f6fc');
    r += rows.length + 2;
  });

  autoSize_(sh, 7);
}

/** === 商品別売上（年度ごと） === */
function writeProductSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_PRODUCT);
  let r = 1;
  sh.getRange(r++, 1).setValue('商品別売上（年度ごと）').setFontWeight('bold').setFontSize(14);
  r++;
  if (!reports.fyList.length) { sh.getRange(r, 1).setValue('データがありません。'); return; }

  reports.fyList.forEach(function (fy) {
    sh.getRange(r++, 1).setValue('■ ' + fiscalYearLabel_(fy))
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    const header = ['決済', '商品／注文', '事業', '件数', '売上（総額）', '返金', '手数料', '純額'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const list = reports.byProduct[fy];
    const rows = list.map(function (x) {
      return [x.source, x.label, x.business || '未分類', x.agg.count, x.agg.gross, x.agg.refund, x.agg.fee, x.agg.net];
    });
    if (rows.length) {
      sh.getRange(r, 1, rows.length, header.length).setValues(rows);
      sh.getRange(r, 5, rows.length, 4).setNumberFormat(YEN_FMT);
      r += rows.length;
    }
    r += 2;
  });
  autoSize_(sh, 8);
}

/** === 決済手段別（年度ごと） === */
function writeMethodSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_METHOD);
  let r = 1;
  sh.getRange(r++, 1).setValue('決済手段別の内訳（年度ごと）').setFontWeight('bold').setFontSize(14);
  r++;
  if (!reports.fyList.length) { sh.getRange(r, 1).setValue('データがありません。'); return; }

  reports.fyList.forEach(function (fy) {
    sh.getRange(r++, 1).setValue('■ ' + fiscalYearLabel_(fy))
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    const header = ['決済', '決済手段', '件数', '売上（総額）', '返金', '純額'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const list = reports.byMethod[fy];
    const rows = list.map(function (x) {
      return [x.source, x.label, x.agg.count, x.agg.gross, x.agg.refund, x.agg.net];
    });
    if (rows.length) {
      sh.getRange(r, 1, rows.length, header.length).setValues(rows);
      sh.getRange(r, 4, rows.length, 3).setNumberFormat(YEN_FMT);
      r += rows.length;
    }
    r += 2;
  });
  autoSize_(sh, 6);
}

/** === 入金照合 === */
function writeReconcileSheet_(ss, payouts) {
  const sh = prepSheet_(ss, SHEETS.RECONCILE);
  sh.getRange(1, 1).setValue('入金額との照合').setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setValue('各入金（振込）について、明細の純額合計と実際の入金額が一致するかを検算します。');
  const header = ['決済', '年度', '入金ID', '着金日', '実際の入金額', '明細の純額合計', '差額', '判定'];
  const hr = 4;
  sh.getRange(hr, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');

  const sorted = (payouts || []).slice().sort(function (a, b) {
    return b.arrivalDate.getTime() - a.arrivalDate.getTime();
  });
  const body = sorted.map(function (p) {
    const diff = p.payoutAmount - p.calculatedNet;
    const isKomoju = p.source === 'Komoju';
    // Komojuの純額は概算のため差額は出る。実際の入金額（payoutAmount）が正。
    const judge = isKomoju ? '実入金額（純額は概算）' : (Math.abs(diff) <= 1 ? '✓ 一致' : '要確認');
    return [
      p.source,
      fiscalYearLabel_(fiscalYearOf_(p.arrivalDate)),
      p.payoutId,
      Utilities.formatDate(p.arrivalDate, 'Asia/Tokyo', 'yyyy/MM/dd'),
      p.payoutAmount, p.calculatedNet, diff, judge,
    ];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 5, body.length, 3).setNumberFormat(YEN_FMT);
    for (let i = 0; i < body.length; i++) {
      if (body[i][7] === '要確認') {
        sh.getRange(hr + 1 + i, 1, 1, header.length).setBackground('#fdecea');
      }
    }
  } else {
    sh.getRange(hr + 1, 1).setValue('入金データがありません。');
  }
  autoSize_(sh, header.length);
}

function autoSize_(sh, numCols) {
  for (let c = 1; c <= numCols; c++) sh.autoResizeColumn(c);
}

/**
 * 会社提出用の明細シートを書き出す。
 * 列: source, date, yearMonth, type, product, gross, fee, net, payoutDate
 * 見出しは日本語。product は Komoju仕分けの内容も反映済み（buildReports_ で上書き済みの txns を渡す）。
 */
function writeSubmissionSheet_(ss, txns) {
  const sh = prepSheet_(ss, SHEETS.SUBMISSION);
  const header = ['決済サービス', '取引日', '対象月', '種別', '商品名', '事業', '売上（総額）', '手数料', '純額', '入金日'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
  sh.setFrozenRows(1);

  const sorted = (txns || []).slice().sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
  const rows = sorted.map(function (t) {
    return [
      t.source,
      Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy/MM/dd'),
      t.yearMonth || Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy-MM'),
      t.type,
      t.product,
      t.business || '未分類',
      t.gross,
      t.fee,
      t.net,
      t.payoutDate ? Utilities.formatDate(t.payoutDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '',
    ];
  });
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 3).setNumberFormat(YEN_FMT); // 売上・手数料・純額
  }
  // 末尾の余分な空白行を削除（提出用に見た目を整える）
  const need = rows.length + 1;
  if (sh.getMaxRows() > need) sh.deleteRows(need + 1, sh.getMaxRows() - need);
  autoSize_(sh, header.length);
}


// ====================================================================
// 以下は Main.gs の内容
// ====================================================================
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

