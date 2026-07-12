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

/** 任意の Komoju エンドポイントを叩いて {status, text} を返す（例外にしない）。診断用。 */
function komojuTry_(method, path) {
  try {
    const res = UrlFetchApp.fetch(KOMOJU_BASE + path, {
      method: method, headers: komojuHeaders_(), muteHttpExceptions: true,
    });
    return { status: res.getResponseCode(), text: res.getContentText() };
  } catch (e) {
    return { status: -1, text: String(e) };
  }
}

/** Komojuの精算（入金/振込）データの入口を探す。診断用。 */
function komojuProbeSettlements_() {
  const paths = [
    '/settlements?limit=3',
    '/payouts?limit=3',
    '/deposits?limit=3',
    '/statements?limit=3',
    '/transfers?limit=3',
    '/settlement?limit=3',
    '/merchant_settlements?limit=3',
    '/settlements',
    '/payouts',
  ];
  return paths.map(function (p) {
    const r = komojuTry_('get', p);
    return { path: p, status: r.status, text: r.text };
  });
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
