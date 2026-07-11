/**
 * Http.gs
 * -----------------------------------------------------------------------------
 * HTTP まわりの共通ユーティリティ。
 */

/**
 * key=value の配列からクエリ文字列を作る。
 * ブラケット記法（例: ['arrival_date[gte]', 1700000000]）や
 * 同名キーの重複（例: expand[]）にも対応するため、[key, value] の配列で受け取る。
 *
 * @param {Array<[string, (string|number)]>} pairs
 * @return {string} 例: "limit=100&arrival_date%5Bgte%5D=1700000000"
 */
function buildQuery_(pairs) {
  return pairs
    .filter(function (p) { return p[1] !== undefined && p[1] !== null && p[1] !== ''; })
    .map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    })
    .join('&');
}

/**
 * GET して JSON を返す。エラー時は分かりやすい例外を投げる。
 *
 * @param {string} url
 * @param {Object} headers 追加ヘッダ（Authorization など）
 * @return {Object} パース済み JSON
 */
function httpGetJson_(url, headers) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: headers || {},
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('HTTP ' + code + ' : ' + url + '\n' + body.slice(0, 500));
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('JSON パース失敗: ' + url + '\n' + body.slice(0, 300));
  }
}
