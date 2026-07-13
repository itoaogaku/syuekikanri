/**
 * Wix.gs
 * -----------------------------------------------------------------------------
 * Wix「支払い(Payments)」トランザクション API クライアント。
 *
 * 目的：Komoju の決済は商品名が注文コードしか入らないため、Wixの支払いデータ
 *       （/payments/v2/transactions）から本当の商品名を取得して補う。
 *       支払いデータには 金額・日付・商品名・決済代行ID が揃っている。
 *
 * 突き合わせ：決済代行ID（providerTransactionId）で厳密一致、無ければ
 *            金額＋日付（Stripe以外・同額の商品名が一意な場合）で一致。
 *
 * 認証：アカウントのAPIキー ＋ サイトID ＋ アカウントID をヘッダで渡す。
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

/** GET して {status, text} を返す（例外にしない）。 */
function wixGet_(path) {
  try {
    const res = UrlFetchApp.fetch(WIX_BASE + path, {
      method: 'get', headers: wixHeaders_(), muteHttpExceptions: true,
    });
    return { status: res.getResponseCode(), text: res.getContentText() };
  } catch (e) {
    return { status: -1, text: String(e) };
  }
}

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
    const r = wixGet_('/payments/v2/transactions?limit=' + limit + '&offset=' + offset);
    if (r.status !== 200) break;
    let j;
    try { j = JSON.parse(r.text); } catch (e) { break; }
    const txs = j.transactions || [];
    if (!txs.length) break;
    txs.forEach(function (t) { out.push(t); });

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
 * 支払いトランザクションから突き合わせ用の索引を1回だけ作る。
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

/**
 * 事前に作った索引を使って Komoju 明細に商品名を付与する。
 * @return {{filled:number, byId:number, byAmt:number, target:number}}
 */
function wixApplyKomojuIndex_(txns, index) {
  const stats = { filled: 0, byId: 0, byAmt: 0, target: 0 };
  if (!index) return stats;
  const byProv = index.byProv || {};
  const nonStripe = index.nonStripe || [];
  const DAY = 86400000;
  const ymd = function (d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); };
  txns.forEach(function (t) {
    if (t.source !== 'Komoju') return;
    stats.target++;
    // ① 決済代行ID（Komoju決済ID）で厳密一致
    let name = byProv[String(t.id)];
    let via = name ? 'id' : '';
    if (!name) {
      const amt = Math.round(t.gross);
      const tYmd = ymd(t.date);
      // ② 同じ金額・同じ日付で照合。商品名が一意なら採用
      const sameDay = nonStripe.filter(function (w) {
        return w.amt === amt && w.date && ymd(w.date) === tYmd;
      }).map(function (w) { return w.name; });
      if (sameDay.length && allSame_(sameDay)) { name = sameDay[0]; via = 'amt'; }
      // ③ ダメなら同じ金額・±4日（コンビニの入金日ズレに対応）
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
      stats.filled++;
      if (via === 'id') stats.byId++; else stats.byAmt++;
    }
  });
  return stats;
}

/**
 * Komoju 明細の商品名を、Wixの支払いデータから補完する。
 * @return {{filled:number, byId:number, byAmt:number, target:number}}
 */
function wixEnrichKomojuTxns_(txns) {
  const empty = { filled: 0, byId: 0, byAmt: 0, target: 0 };
  if (!isWixEnabled_()) return empty;
  let minDate = null;
  txns.forEach(function (t) {
    if (t.source === 'Komoju' && t.date && (!minDate || t.date.getTime() < minDate.getTime())) minDate = t.date;
  });
  if (!minDate) return empty;
  const index = wixBuildTxIndex_(new Date(minDate.getTime() - 4 * 86400000));
  return wixApplyKomojuIndex_(txns, index);
}

function allSame_(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[0]) return false;
  return true;
}
