/**
 * Aggregate.gs
 * -----------------------------------------------------------------------------
 * 正規化済みの取引明細（Stripe + Komoju）を、報告用の各集計に変換する。
 *
 * 生成する集計:
 *   1. byProduct  : 商品別の売上（件数・総額・返金・純額）
 *   2. byMethod   : 決済手段別の内訳
 *   3. totals     : 手数料・返金の全体内訳
 *   4. reconcile  : 入金額（振込）との照合（Stripe payout 単位）
 */

/**
 * @param {Array<Object>} txns 正規化済み明細
 * @param {Array<Object>} stripePayouts Stripe の payout サマリー
 * @return {Object}
 */
function aggregate_(txns, stripePayouts) {
  return {
    byProduct: aggByProduct_(txns),
    byMethod: aggByMethod_(txns),
    totals: aggTotals_(txns),
    reconcile: stripePayouts || [],
    txns: txns,
  };
}

/** 商品別集計 */
function aggByProduct_(txns) {
  const map = {};
  txns.forEach(function (t) {
    const key = t.source + ' / ' + t.product;
    if (!map[key]) {
      map[key] = {
        source: t.source, product: t.product,
        count: 0, gross: 0, refund: 0, fee: 0, net: 0,
      };
    }
    const row = map[key];
    if (t.kind === 'sale') { row.count += 1; row.gross += t.gross; }
    else if (t.kind === 'refund') { row.refund += -t.gross; } // gross は負値なので符号反転
    row.fee += t.fee;
    row.net += t.net;
  });
  return Object.keys(map)
    .map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.gross - a.gross; });
}

/** 決済手段別集計 */
function aggByMethod_(txns) {
  const map = {};
  txns.forEach(function (t) {
    const key = t.source + ' / ' + t.method;
    if (!map[key]) {
      map[key] = { source: t.source, method: t.method, count: 0, gross: 0, refund: 0, net: 0 };
    }
    const row = map[key];
    if (t.kind === 'sale') { row.count += 1; row.gross += t.gross; }
    else if (t.kind === 'refund') { row.refund += -t.gross; }
    row.net += t.net;
  });
  return Object.keys(map)
    .map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.gross - a.gross; });
}

/** 全体の手数料・返金内訳 */
function aggTotals_(txns) {
  const t = { grossSales: 0, refunds: 0, fees: 0, net: 0, saleCount: 0, refundCount: 0 };
  txns.forEach(function (x) {
    if (x.kind === 'sale') { t.grossSales += x.gross; t.saleCount += 1; }
    else if (x.kind === 'refund') { t.refunds += -x.gross; t.refundCount += 1; }
    t.fees += x.fee;
    t.net += x.net;
  });
  return t;
}
