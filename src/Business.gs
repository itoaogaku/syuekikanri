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
  txns.forEach(function (t) {
    const code = String(t.orderId || t.product || '');
    if (!code || existing[code] || seen[code]) return;
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
