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
