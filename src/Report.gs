/**
 * Report.gs
 * -----------------------------------------------------------------------------
 * 集計結果をスプレッドシートへ書き出すモジュール。
 */

const YEN_FMT = '#,##0" 円"';

/** 集計結果を各シートへ書き出す */
function writeReport_(agg, periodLabel) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  writeSummarySheet_(ss, agg, periodLabel);
  writeProductSheet_(ss, agg.byProduct, periodLabel);
  writeMethodSheet_(ss, agg.byMethod, periodLabel);
  writeReconcileSheet_(ss, agg.reconcile, periodLabel);
  writeDetailSheet_(ss, agg.txns, periodLabel);
}

/** シートを取得（無ければ作成）し、内容をクリア */
function prepSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  return sh;
}

/** 見出し行の装飾 */
function styleHeader_(sh, row, numCols) {
  const rng = sh.getRange(row, 1, 1, numCols);
  rng.setFontWeight('bold').setBackground('#e8eef7');
}

/** ①手数料・返金内訳などのサマリー */
function writeSummarySheet_(ss, agg, periodLabel) {
  const sh = prepSheet_(ss, SHEETS.SUMMARY);
  const t = agg.totals;

  let r = 1;
  sh.getRange(r++, 1).setValue('売上レポート サマリー').setFontWeight('bold').setFontSize(14);
  sh.getRange(r++, 1).setValue('対象期間：' + periodLabel);
  sh.getRange(r++, 1).setValue('作成日時：' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  r++;

  sh.getRange(r, 1).setValue('■ 手数料・返金の内訳');
  sh.getRange(r++, 1).setFontWeight('bold');
  const rows = [
    ['総売上（手数料込み・返金前）', t.grossSales, t.saleCount + ' 件'],
    ['返金合計', -t.refunds, t.refundCount + ' 件'],
    ['決済手数料合計', -t.fees, ''],
    ['純額（実質の入金相当）', t.net, ''],
  ];
  sh.getRange(r, 1, rows.length, 3).setValues(rows);
  sh.getRange(r, 2, rows.length, 1).setNumberFormat(YEN_FMT);
  sh.getRange(r + rows.length - 1, 1, 1, 3).setFontWeight('bold');
  r += rows.length + 1;

  sh.getRange(r++, 1).setValue('※ Komoju の手数料は概算（設定した手数料率）です。正確な額は Komoju 精算レポートで確定します。')
    .setFontColor('#888888').setFontSize(9);

  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(3, 90);
}

/** 商品別売上 */
function writeProductSheet_(ss, list, periodLabel) {
  const sh = prepSheet_(ss, SHEETS.BY_PRODUCT);
  sh.getRange(1, 1).setValue('商品別売上（' + periodLabel + '）').setFontWeight('bold').setFontSize(13);
  const header = ['決済', '商品／注文', '販売件数', '売上（総額）', '返金', '手数料', '純額'];
  const hr = 3;
  sh.getRange(hr, 1, 1, header.length).setValues([header]);
  styleHeader_(sh, hr, header.length);

  const body = list.map(function (x) {
    return [x.source, x.product, x.count, x.gross, x.refund, x.fee, x.net];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 4, body.length, 4).setNumberFormat(YEN_FMT);
  }
  autoSize_(sh, header.length);
}

/** 決済手段別 */
function writeMethodSheet_(ss, list, periodLabel) {
  const sh = prepSheet_(ss, SHEETS.BY_METHOD);
  sh.getRange(1, 1).setValue('決済手段別の内訳（' + periodLabel + '）').setFontWeight('bold').setFontSize(13);
  const header = ['決済', '決済手段', '件数', '売上（総額）', '返金', '純額'];
  const hr = 3;
  sh.getRange(hr, 1, 1, header.length).setValues([header]);
  styleHeader_(sh, hr, header.length);

  const body = list.map(function (x) {
    return [x.source, x.method, x.count, x.gross, x.refund, x.net];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 4, body.length, 3).setNumberFormat(YEN_FMT);
  }
  autoSize_(sh, header.length);
}

/** 入金照合（Stripe payout 単位の検算） */
function writeReconcileSheet_(ss, list, periodLabel) {
  const sh = prepSheet_(ss, SHEETS.RECONCILE);
  sh.getRange(1, 1).setValue('入金額との照合（' + periodLabel + '）').setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1).setValue('各入金（振込）について、明細の純額合計と実際の入金額が一致するかを検算します。');
  const header = ['決済', '入金ID', '着金日', '実際の入金額', '明細の純額合計', '差額', '判定'];
  const hr = 4;
  sh.getRange(hr, 1, 1, header.length).setValues([header]);
  styleHeader_(sh, hr, header.length);

  const body = list.map(function (p) {
    const diff = p.payoutAmount - p.calculatedNet;
    return [
      p.source,
      p.payoutId,
      Utilities.formatDate(p.arrivalDate, 'Asia/Tokyo', 'yyyy/MM/dd'),
      p.payoutAmount,
      p.calculatedNet,
      diff,
      Math.abs(diff) <= 1 ? '✓ 一致' : '要確認',
    ];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 4, body.length, 3).setNumberFormat(YEN_FMT);
    // 差額がある行を強調
    for (let i = 0; i < body.length; i++) {
      if (body[i][6] === '要確認') {
        sh.getRange(hr + 1 + i, 1, 1, header.length).setBackground('#fdecea');
      }
    }
  } else {
    sh.getRange(hr + 1, 1).setValue('対象期間に Stripe の入金はありませんでした。');
  }
  autoSize_(sh, header.length);
}

/** 明細（元データ） */
function writeDetailSheet_(ss, txns, periodLabel) {
  const sh = prepSheet_(ss, SHEETS.DETAIL);
  sh.getRange(1, 1).setValue('取引明細（' + periodLabel + '）').setFontWeight('bold').setFontSize(13);
  const header = ['決済', '取引ID', '日時', '区分', '種別', '商品／注文', '注文ID', '決済手段', '総額', '手数料', '純額', '入金ID'];
  const hr = 3;
  sh.getRange(hr, 1, 1, header.length).setValues([header]);
  styleHeader_(sh, hr, header.length);

  const body = txns.map(function (t) {
    return [
      t.source, t.id,
      Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
      t.kind === 'sale' ? '売上' : (t.kind === 'refund' ? '返金' : 'その他'),
      t.type, t.product, t.orderId, t.method,
      t.gross, t.fee, t.net, t.payoutId,
    ];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 9, body.length, 3).setNumberFormat(YEN_FMT);
  }
  autoSize_(sh, header.length);
}

/** 列幅を自動調整 */
function autoSize_(sh, numCols) {
  for (let c = 1; c <= numCols; c++) sh.autoResizeColumn(c);
}
