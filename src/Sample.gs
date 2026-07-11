/**
 * Sample.gs
 * -----------------------------------------------------------------------------
 * APIキーが無くても、蓄積・年度・事業別の見た目を確認できるサンプル。
 * 複数月・2年度・複数事業・Stripe/Komoju をまたいだデータを台帳へ入れて再生成する。
 * メニュー「★ サンプルデータで表示を確認」から実行。
 */

function runSampleReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 既存の台帳をクリア（サンプルを入れ直す）
  [SHEETS.LEDGER, SHEETS.PAYOUTS].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (sh) ss.deleteSheet(sh);
  });
  ensureMappingSheet_(ss); // 事業マッピングの記入例を用意

  const D = function (y, m, d) { return new Date(y, m - 1, d, 12, 0, 0); };
  const T = function (source, id, date, kind, product, method, gross, fee, net, payoutId) {
    return {
      source: source, id: id, date: date, kind: kind,
      type: kind === 'refund' ? 'refund' : (source === 'Stripe' ? 'charge' : 'payment'),
      product: product, orderId: '', method: method,
      gross: gross, fee: fee, net: net, payoutId: payoutId, payoutDate: date,
    };
  };

  // ---- サンプル取引（4月始まり年度：FY2025=2025/4〜2026/3, FY2026=2026/4〜） ----
  const byMonth = {
    '2025-05': [
      T('Stripe', 's1', D(2025, 5, 3), 'sale', 'オンライン講座A', 'カード(visa)', 12000, 428, 11572, 'po_2505'),
      T('Komoju', 'k1', D(2025, 5, 6), 'sale', '書籍セットB', 'コンビニ', 4800, 175, 4625, 'komoju'),
    ],
    '2025-11': [
      T('Stripe', 's2', D(2025, 11, 4), 'sale', 'グッズC', 'カード(visa)', 3000, 107, 2893, 'po_2511'),
      T('Stripe', 's3', D(2025, 11, 20), 'sale', 'オンライン講座A', 'カード(mastercard)', 12000, 428, 11572, 'po_2511'),
      T('Komoju', 'k2', D(2025, 11, 10), 'sale', 'オンライン講座A', '銀行振込', 12000, 438, 11562, 'komoju'),
    ],
    '2026-02': [
      T('Stripe', 's4', D(2026, 2, 8), 'sale', '書籍セットB', 'カード(visa)', 4800, 171, 4629, 'po_2602'),
      T('Stripe', 's5', D(2026, 2, 9), 'refund', '書籍セットB', 'カード(visa)', -4800, 0, -4800, 'po_2602'),
    ],
    '2026-05': [
      T('Stripe', 's6', D(2026, 5, 3), 'sale', 'オンライン講座A', 'カード(visa)', 12000, 428, 11572, 'po_2605'),
      T('Komoju', 'k3', D(2026, 5, 7), 'sale', 'グッズC', 'PayPay', 3000, 110, 2890, 'komoju'),
    ],
  };

  const payoutsByMonth = {
    '2025-05': [P('po_2505', D(2025, 5, 15), 11572)],
    '2025-11': [P('po_2511', D(2025, 11, 15), 2893 + 11572)],
    '2026-02': [P('po_2602', D(2026, 2, 15), 4629 - 4800)],
    '2026-05': [P('po_2605', D(2026, 5, 15), 11572)],
  };

  Object.keys(byMonth).forEach(function (ym) {
    upsertLedger_(ss, byMonth[ym], ym, ['Stripe', 'Komoju']);
    upsertPayoutLedger_(ss, payoutsByMonth[ym] || [], ym, ['Stripe', 'Komoju']);
  });

  regenerateReports();
  ss.toast('サンプル（2年度・複数事業）を作成しました。各シートをご確認ください。', '完了', 6);
}

/** サンプル用の payout（calculatedNet は入金額と一致させておく） */
function P(payoutId, arrival, amount) {
  return {
    source: 'Stripe', payoutId: payoutId, arrivalDate: arrival,
    payoutAmount: amount, calculatedNet: amount, status: 'paid',
  };
}
