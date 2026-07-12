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
