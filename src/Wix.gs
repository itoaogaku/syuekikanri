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

/**
 * Komoju 明細の商品名を Wix の商品名で補う（Wix未設定なら何もしない）。
 * 元の注文コードは orderId 列に残す。全体を try/catch で守り、Wix側の
 * 不調で本体処理が止まらないようにする。
 *
 * @param {Array<Object>} txns
 */
function wixEnrichKomojuTxns_(txns) {
  if (!isWixEnabled_()) return;
  const cache = {}; // code -> productLabel|null
  txns.forEach(function (t) {
    if (t.source !== 'Komoju') return;
    const code = String(t.product || '');
    if (!code) return;
    if (!(code in cache)) {
      const order = wixGetOrderById_(code);
      cache[code] = order ? wixOrderProductLabel_(order) : null;
    }
    if (cache[code]) {
      if (!t.orderId) t.orderId = code; // 元コードを残す
      t.product = cache[code];
    }
  });
}
