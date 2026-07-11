/**
 * Sample.gs
 * -----------------------------------------------------------------------------
 * APIキーが無くてもレポートの見た目を確認できるサンプルデータ。
 * メニュー「★ サンプルデータで表示を確認」から実行。
 */

function runSampleReport() {
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(); // 当月の1つ前を対象に見せる
  const base = new Date(y, mo - 1, 10, 12, 0, 0);
  const periodLabel = Utilities.formatDate(base, 'Asia/Tokyo', 'yyyy年M月') + '（サンプル）';

  const d = function (day) { return new Date(base.getFullYear(), base.getMonth(), day, 12, 0, 0); };

  const txns = [
    // Stripe 売上
    mk_('Stripe', 'txn_1', d(3), 'sale', 'charge', 'オンライン講座A', 'W-1001', 'カード(visa)', 12000, 428, 11572, 'po_A'),
    mk_('Stripe', 'txn_2', d(5), 'sale', 'charge', 'オンライン講座A', 'W-1002', 'カード(mastercard)', 12000, 428, 11572, 'po_A'),
    mk_('Stripe', 'txn_3', d(8), 'sale', 'charge', '書籍セットB', 'W-1003', 'カード(visa)', 4800, 171, 4629, 'po_A'),
    mk_('Stripe', 'txn_4', d(9), 'refund', 'refund', '書籍セットB', 'W-1003', 'カード(visa)', -4800, 0, -4800, 'po_A'),
    // Komoju 売上（手数料は概算）
    mk_('Komoju', 'kj_1', d(4), 'sale', 'payment', 'オンライン講座A', 'K-2001', 'コンビニ', 12000, 438, 11562, 'komoju'),
    mk_('Komoju', 'kj_2', d(6), 'sale', 'payment', 'グッズC', 'K-2002', '銀行振込', 3000, 110, 2890, 'komoju'),
    mk_('Komoju', 'kj_3', d(7), 'sale', 'payment', 'グッズC', 'K-2003', 'PayPay', 3000, 110, 2890, 'komoju'),
  ];

  const stripePayouts = [{
    source: 'Stripe', payoutId: 'po_A', arrivalDate: d(15),
    payoutAmount: 22973, // 実際の入金額（サンプル）
    calculatedNet: 11572 + 11572 + 4629 - 4800, // = 22973（明細純額合計）
    status: 'paid',
  }];

  const agg = aggregate_(txns, stripePayouts);
  writeReport_(agg, periodLabel);
  SpreadsheetApp.getActiveSpreadsheet().toast('サンプルレポートを作成しました。各シートをご確認ください。', '完了', 5);
}

function mk_(source, id, date, kind, type, product, orderId, method, gross, fee, net, payoutId) {
  return {
    source: source, id: id, date: date, kind: kind, type: type,
    gross: gross, fee: fee, net: net, currency: 'jpy',
    product: product, orderId: orderId, method: method,
    payoutId: payoutId, payoutDate: date,
  };
}
