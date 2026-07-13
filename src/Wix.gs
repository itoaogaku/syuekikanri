/**
 * Wix.gs
 * -----------------------------------------------------------------------------
 * Wix eCommerce（注文）API クライアント。
 *
 * 目的：Komoju の決済は商品名が「注文コード」しか入っていないため、
 *       Wix の注文データから本当の商品名を取得して補う。
 *
 * 認証：アカウントのAPIキー ＋ サイトID ＋ アカウントID をヘッダで渡す。
 * 参考：https://dev.wix.com/docs/rest/business-solutions/e-commerce/orders
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

/** POST して JSON を返す */
function wixPostJson_(path, body) {
  const res = UrlFetchApp.fetch(WIX_BASE + path, {
    method: 'post',
    headers: wixHeaders_(),
    payload: JSON.stringify(body || {}),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Wix HTTP ' + code + ' : ' + path + '\n' + text.slice(0, 500));
  }
  return JSON.parse(text);
}

/**
 * 注文を検索して取得（新しい順）。
 * @param {number} limit 取得件数
 * @return {Array<Object>} order の配列
 */
function wixSearchOrders_(limit) {
  const body = {
    search: {
      cursorPaging: { limit: limit || 100 },
      sort: [{ fieldName: 'createdDate', order: 'DESC' }],
    },
  };
  const json = wixPostJson_('/ecom/v1/orders/search', body);
  return json.orders || [];
}

/** 注文IDで1件取得（見つからなければ null） */
function wixGetOrderById_(orderId) {
  try {
    const res = UrlFetchApp.fetch(WIX_BASE + '/ecom/v1/orders/' + encodeURIComponent(orderId), {
      method: 'get',
      headers: wixHeaders_(),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return null;
    const json = JSON.parse(res.getContentText());
    return json.order || json || null;
  } catch (e) {
    return null;
  }
}

/**
 * 注文を新しい順にページ送りで取得し、指定日 fromDate より古い注文が
 * 出てきたら停止する（フィルターAPIの書式差異を避けるためクライアント側で絞る）。
 * @param {Date} fromDate これより新しい注文まで取得
 * @return {Array<Object>}
 */
function wixListOrdersDescUntil_(fromDate) {
  const out = [];
  let cursor = null;
  let guard = 0;
  while (guard < 60) {
    guard++;
    const search = cursor
      ? { cursorPaging: { limit: 100, cursor: cursor } }
      : { cursorPaging: { limit: 100 }, sort: [{ fieldName: 'createdDate', order: 'DESC' }] };
    const json = wixPostJson_('/ecom/v1/orders/search', { search: search });
    const orders = json.orders || [];
    if (!orders.length) break;
    orders.forEach(function (o) { out.push(o); });

    const last = orders[orders.length - 1];
    const lastDate = new Date(last.createdDate);
    if (lastDate.getTime() < fromDate.getTime()) break; // これ以降はもっと古い

    const meta = json.metadata || json.pagingMetadata || {};
    cursor = (meta.cursors || {}).next || null;
    if (!cursor) break;
  }
  return out;
}

/** 注文の合計金額（数値・円）を返す */
function wixTotal_(order) {
  const ps = order.priceSummary || {};
  const t = ps.total || {};
  const v = parseFloat(t.amount != null ? t.amount : (order.totals && order.totals.total));
  return isFinite(v) ? Math.round(v) : '';
}

/** イベント一覧を取得（中身が取れる GET ?limit 方式）。 */
function wixListEvents_(limit) {
  const r = wixTry_('get', '/events/v1/events?limit=' + (limit || 50), null);
  try { return (JSON.parse(r.text).events) || []; } catch (e) { return []; }
}

/** イベントの開始日（Date）を取り出す */
function wixEventStart_(e) {
  const s = e && e.scheduling && e.scheduling.config && e.scheduling.config.startDate;
  return s ? new Date(s) : null;
}

/**
 * 「購入者・注文データ」の入口を、過去の対象イベントに絞って探す診断。
 * tickets / guests など複数の入口を叩き、結果を返す。
 */
function wixProbePurchases_() {
  const results = [];
  const events = wixListEvents_(50);
  const now = new Date();
  // 記録挑戦会・大会・対抗戦 で、既に開催済み（＝購入がありそう）なものを対象に
  const targets = events.filter(function (e) {
    const t = e.title || '';
    const start = wixEventStart_(e);
    const isPast = start ? (start.getTime() < now.getTime()) : true;
    return /記録挑戦会|対抗戦|大会/.test(t) && isPast;
  }).slice(0, 3);

  if (!targets.length && events.length) targets.push(events[0]);

  targets.forEach(function (e) {
    const id = e.id;
    const eps = [
      ['tickets(GET)', 'get', '/events/v1/events/' + id + '/tickets?limit=100', null],
      ['guests(GET)', 'get', '/events/v1/events/' + id + '/guests?limit=100', null],
      ['guests query v3', 'post', '/events/v3/guests/query', { query: { filter: { eventId: id }, cursorPaging: { limit: 50 } } }],
      ['guests query v1', 'post', '/events/v1/guests/query', { query: { paging: { limit: 50 }, filter: { eventId: id } } }],
    ];
    eps.forEach(function (ep) {
      const r = wixTry_(ep[1], ep[2], ep[3]);
      results.push({ label: '[' + (e.title || '').slice(0, 16) + '] ' + ep[0], method: ep[1], path: ep[2], status: r.status, text: r.text });
    });
  });
  return results;
}

/** 支払い取引のページ送り方法を特定する診断。 */
function wixProbeTxPaging_() {
  const out = [];
  const p1 = wixTry_('get', '/payments/v2/transactions', null);
  let j1 = {};
  try { j1 = JSON.parse(p1.text); } catch (e) { }
  const t1 = j1.transactions || [];
  const pag = j1.pagination || {};
  out.push({ label: 'page1(パラメータ無)', status: p1.status, count: t1.length, note: 'pagination=' + JSON.stringify(pag).slice(0, 500) });
  const firstId1 = t1.length ? (t1[0].transactionId || '') : '';

  // pagination の中から cursor らしき文字列を探す
  const cursors = [];
  (function scan(o) {
    if (!o || typeof o !== 'object') return;
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'string' && v.length >= 8 && /cursor|next|token/i.test(k)) cursors.push(v);
      else if (v && typeof v === 'object') scan(v);
    }
  })(pag);
  const cur = cursors[0] || '';
  out.push({ label: '見つけたカーソル', status: '', count: cursors.length, note: cur.slice(0, 60) });

  const attempts = [
    ['limit=100', '/payments/v2/transactions?limit=100'],
    ['paging.limit=100', '/payments/v2/transactions?paging.limit=100'],
    ['cursorPaging.limit=100', '/payments/v2/transactions?cursorPaging.limit=100'],
  ];
  if (cur) {
    const e = encodeURIComponent(cur);
    attempts.push(['cursor=', '/payments/v2/transactions?cursor=' + e]);
    attempts.push(['cursorPaging.cursor=', '/payments/v2/transactions?cursorPaging.cursor=' + e]);
    attempts.push(['pagination.cursor=', '/payments/v2/transactions?pagination.cursor=' + e]);
    attempts.push(['paging.cursor=', '/payments/v2/transactions?paging.cursor=' + e]);
  }
  attempts.forEach(function (a) {
    const r = wixTry_('get', a[1], null);
    let j = {};
    try { j = JSON.parse(r.text); } catch (e) { }
    const tx = j.transactions || [];
    const dates = tx.map(function (t) { return t.createdAt; }).filter(Boolean).sort();
    const changed = tx.length && firstId1 && (tx[0].transactionId !== firstId1);
    out.push({
      label: a[0], status: r.status, count: tx.length,
      note: (changed ? '★別ページ ' : '同じ/空 ') + (dates[0] || '') + '〜' + (dates[dates.length - 1] || ''),
    });
  });
  return out;
}

/** Wixの「支払い(Payments)」「フォーム(Forms)」系エンドポイント候補を試す。診断用。 */
function wixProbePayments_() {
  const cands = [
    ['payments v2 tx query', 'post', '/payments/v2/transactions/query', { query: { cursorPaging: { limit: 5 } } }],
    ['payments v1 tx query', 'post', '/payments/v1/transactions/query', { query: { paging: { limit: 5 } } }],
    ['payments v3 tx search', 'post', '/payments/v3/transactions/search', { search: { cursorPaging: { limit: 5 } } }],
    ['payments v2 tx GET', 'get', '/payments/v2/transactions?limit=5', null],
    ['payments v1 tx GET', 'get', '/payments/v1/transactions?limit=5', null],
    ['cashier tx query', 'post', '/cashier/v1/transactions/query', { query: { paging: { limit: 5 } } }],
    ['payment-transactions GET', 'get', '/payment-transactions/v1/transactions?limit=5', null],
    ['ecom payments query', 'post', '/ecom/v1/payments/query', { query: { cursorPaging: { limit: 5 } } }],
    ['form-submissions v4 query', 'post', '/form-submissions/v4/submissions/query', { query: { cursorPaging: { limit: 5 } } }],
    ['form-submissions v1 query', 'post', '/form-submissions/v1/submissions/query', { query: { paging: { limit: 5 } } }],
    ['forms v4 submissions query', 'post', '/forms/v4/submissions/query', { query: { cursorPaging: { limit: 5 } } }],
    ['form-submissions v4 search', 'post', '/form-submissions/v4/submissions/search', { search: { cursorPaging: { limit: 5 } } }],
  ];
  return cands.map(function (c) {
    const r = wixTry_(c[1], c[2], c[3]);
    return { label: c[0], method: c[1], path: c[2], status: r.status, text: r.text };
  });
}

/** 任意の Wix エンドポイントを叩いて {status, text} を返す（例外にしない）。診断用。 */
function wixTry_(method, path, body) {
  try {
    const opt = { method: method, headers: wixHeaders_(), muteHttpExceptions: true };
    if (body) opt.payload = JSON.stringify(body);
    const res = UrlFetchApp.fetch(WIX_BASE + path, opt);
    return { status: res.getResponseCode(), text: res.getContentText() };
  } catch (e) {
    return { status: -1, text: String(e) };
  }
}

/** Wixイベント系エンドポイントの候補を順に試す。診断用。 */
function wixProbeEvents_() {
  const results = [];

  // (1) イベント一覧を、取得方法を変えて複数試し、中身が取れたものからIDと名前を得る
  const listAttempts = [
    ['events GET ?limit=50', 'get', '/events/v1/events?limit=50', null],
    ['events query v1 {query.paging}', 'post', '/events/v1/events/query', { query: { paging: { limit: 50 } } }],
    ['events query v1 {paging}', 'post', '/events/v1/events/query', { paging: { limit: 50 } }],
    ['events query v3 {query.paging}', 'post', '/events/v3/events/query', { query: { paging: { limit: 50 } } }],
    ['events query v3 {cursorPaging}', 'post', '/events/v3/events/query', { cursorPaging: { limit: 50 } }],
  ];
  let eid = null;
  const names = [];
  listAttempts.forEach(function (a) {
    const r = wixTry_(a[1], a[2], a[3]);
    let cnt = 0;
    try {
      const j = JSON.parse(r.text);
      const arr = j.events || [];
      cnt = arr.length;
      if (!eid && arr.length) {
        eid = arr[0].id;
        arr.slice(0, 8).forEach(function (e) {
          names.push(e.title || (e.eventInfo && e.eventInfo.title) || e.name || '?');
        });
      }
    } catch (e) { /* ignore */ }
    results.push({ label: a[0] + ' [' + cnt + '件]', method: a[1], path: a[2], status: r.status, text: r.text });
  });
  results.push({ label: '（イベント名サンプル）', method: '', path: '参考', status: names.length, text: JSON.stringify(names) });

  // (2) 注文（オーダー）の入口候補。イベントIDが取れていれば event 別も試す
  const cands = [
    ['orders query(v3)', 'post', '/events/v3/orders/query', { query: { cursorPaging: { limit: 3 } } }],
    ['orders query(v1)', 'post', '/events/v1/orders/query', { query: { paging: { limit: 3 } } }],
    ['ticket-orders query(v1)', 'post', '/events/v1/ticket-orders/query', { query: { paging: { limit: 3 } } }],
  ];
  if (eid) {
    cands.push(['event orders query(v1)', 'post', '/events/v1/orders/query', { eventId: [eid], query: { paging: { limit: 3 } } }]);
    cands.push(['event orders query(v3)', 'post', '/events/v3/orders/query', { eventId: [eid], query: { cursorPaging: { limit: 3 } } }]);
    cands.push(['event別 orders(GET)', 'get', '/events/v1/events/' + eid + '/orders', null]);
    cands.push(['event別 tickets(GET)', 'get', '/events/v1/events/' + eid + '/tickets', null]);
  }
  cands.forEach(function (c) {
    const r = wixTry_(c[1], c[2], c[3]);
    results.push({ label: c[0], method: c[1], path: c[2], status: r.status, text: r.text });
  });

  return results;
}

/** 注文から商品名のラベルを作る（複数商品なら「〇〇 他N点」） */
function wixOrderProductLabel_(order) {
  if (!order) return '';
  const items = order.lineItems || [];
  const names = items.map(function (li) {
    const pn = li.productName || {};
    return pn.original || pn.translated || li.name || '';
  }).filter(function (s) { return s; });
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return names[0] + ' 他' + (names.length - 1) + '点';
}

// ---------------------------------------------------------------------------
// Wix「支払い(Payments)」トランザクションからの商品名補完
//   /payments/v2/transactions に、金額・日付・商品名・決済代行ID が揃っている。
//   これを Komoju 明細と突き合わせて商品名を自動で埋める。
// ---------------------------------------------------------------------------

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
    const r = wixTry_('get', '/payments/v2/transactions?limit=' + limit + '&offset=' + offset, null);
    if (r.status !== 200) break;
    let j;
    try { j = JSON.parse(r.text); } catch (e) { break; }
    const txs = j.transactions || [];
    if (!txs.length) break;
    txs.forEach(function (t) { out.push(t); });

    // このページの最古が fromDate より前なら停止（新しい順のため）
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
 * Komoju 明細の商品名を、Wixの支払いトランザクションから補完する。
 * 突き合わせ:  ① 決済代行ID（providerTransactionId＝Komoju決済ID）で厳密一致
 *              ② 金額＋日付（Stripe以外の支払いに限定）で一致
 * Wix未設定・不調でも本体処理は止めない（呼び出し側で try/catch）。
 *
 * @param {Array<Object>} txns 明細（Komoju を含む）
 * @return {number} 商品名を補完できた件数
 */
function wixEnrichKomojuTxns_(txns) {
  if (!isWixEnabled_()) return 0;
  // 対象Komojuの最も古い日付を基準に、その少し前まで支払いを取得
  let minDate = null;
  txns.forEach(function (t) {
    if (t.source === 'Komoju' && t.date && (!minDate || t.date.getTime() < minDate.getTime())) minDate = t.date;
  });
  if (!minDate) return 0;
  const index = wixBuildTxIndex_(new Date(minDate.getTime() - 4 * 86400000));
  return wixApplyKomojuIndex_(txns, index);
}

/** 商品名を上書きせず、突き合わせ内訳だけ調べる（診断用）。 */
function wixMatchStats_(txns) {
  if (!isWixEnabled_()) return { filled: 0, byId: 0, byAmt: 0, target: 0 };
  let minDate = null;
  txns.forEach(function (t) {
    if (t.source === 'Komoju' && t.date && (!minDate || t.date.getTime() < minDate.getTime())) minDate = t.date;
  });
  if (!minDate) return { filled: 0, byId: 0, byAmt: 0, target: 0 };
  const index = wixBuildTxIndex_(new Date(minDate.getTime() - 4 * 86400000));
  const copy = txns.map(function (t) { return { source: t.source, id: t.id, date: t.date, gross: t.gross, product: t.product, orderId: t.orderId }; });
  return wixApplyKomojuIndex_(copy, index);
}

/**
 * 支払いトランザクションから突き合わせ用の索引を1回だけ作る。
 * （一括取り込みで各月に使い回すため、build と apply を分離）
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

/** 事前に作った索引を使って Komoju 明細に商品名を付与する。 */
function wixApplyKomojuIndex_(txns, index) {
  if (!index) return 0;
  const byProv = index.byProv || {};
  const nonStripe = index.nonStripe || [];
  const DAY = 86400000;
  const ymd = function (d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); };
  let filled = 0, byId = 0, byAmt = 0, target = 0;
  txns.forEach(function (t) {
    if (t.source !== 'Komoju') return;
    target++;
    // ① 決済代行ID（Komoju決済ID）で厳密一致
    let name = byProv[String(t.id)];
    let via = name ? 'id' : '';
    if (!name) {
      const amt = Math.round(t.gross);
      const tYmd = ymd(t.date);
      // ② まず「同じ金額・同じ日付」で照合。商品名が一意なら採用
      const sameDay = nonStripe.filter(function (w) {
        return w.amt === amt && w.date && ymd(w.date) === tYmd;
      }).map(function (w) { return w.name; });
      if (sameDay.length && allSame_(sameDay)) { name = sameDay[0]; via = 'amt'; }
      // ③ ダメなら「同じ金額・±4日」（コンビニの入金日ズレに対応）
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
      filled++;
      if (via === 'id') byId++; else byAmt++;
    }
  });
  return { filled: filled, byId: byId, byAmt: byAmt, target: target };
}

function allSame_(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[0]) return false;
  return true;
}
