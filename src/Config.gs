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
