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
  SUMMARY: 'サマリー',          // ①手数料・返金 ②入金照合 ③決済手段別 のまとめ
  BY_PRODUCT: '商品別売上',      // 商品別の集計
  BY_METHOD: '決済手段別',       // 決済手段（カード/コンビニ等）別の集計
  RECONCILE: '入金照合',         // 入金額（振込）との照合・検算
  DETAIL: '明細',               // 取得した全取引の明細（元データ）
};

/** スクリプトプロパティのキー名 */
const PROP_KEYS = {
  STRIPE_SECRET: 'STRIPE_SECRET_KEY',   // 例: sk_live_xxx（読み取り専用の制限キー推奨）
  KOMOJU_SECRET: 'KOMOJU_SECRET_KEY',   // Komoju のシークレットキー
  KOMOJU_FEE_RATE: 'KOMOJU_FEE_RATE',   // Komoju の手数料率（例 "0.0365" = 3.65%）※純額の概算用
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
