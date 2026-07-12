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
