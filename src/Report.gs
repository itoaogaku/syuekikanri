/**
 * Report.gs
 * -----------------------------------------------------------------------------
 * 集計結果をスプレッドシートへ書き出す。すべて年度ごとにブロック分けして表示。
 */

const YEN_FMT = '#,##0" 円"';

/** サービスの表示順（Stripe→Komoju→その他） */
function sourceOrder_(sources) {
  const pref = { 'Stripe': 0, 'Komoju': 1 };
  return sources.slice().sort(function (a, b) {
    const pa = (a in pref) ? pref[a] : 99;
    const pb = (b in pref) ? pref[b] : 99;
    return pa - pb || String(a).localeCompare(String(b));
  });
}

function prepSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  return sh;
}

/** 全レポートを書き出す */
function writeAllReports_(ss, reports) {
  writeAnnualSheet_(ss, reports);
  writeBusinessSheet_(ss, reports);
  writeProductSheet_(ss, reports);
  writeMethodSheet_(ss, reports);
  writeReconcileSheet_(ss, reports.reconcile);
}

/** === 年度サマリー === */
function writeAnnualSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.ANNUAL);
  let r = 1;
  sh.getRange(r++, 1).setValue('年度サマリー（Stripe / Komoju の年間合計）')
    .setFontWeight('bold').setFontSize(14);
  sh.getRange(r++, 1).setValue('更新：' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  r++;

  if (!reports.fyList.length) {
    sh.getRange(r, 1).setValue('データがありません。月次レポートを実行すると台帳に蓄積されます。');
    return;
  }

  reports.fyList.forEach(function (fy) {
    const a = reports.annual[fy];

    sh.getRange(r, 1).setValue('■ ' + fiscalYearLabel_(fy) + '（' + fiscalYearRangeLabel_(fy) + '）')
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    r++;

    // 合計テーブル
    const header = ['決済', '総売上', '返金', '手数料', '純額（入金相当）', '販売件数'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const sources = sourceOrder_(Object.keys(a.bySource));
    const rows = [];
    sources.forEach(function (s) {
      const g = a.bySource[s];
      rows.push([s, g.gross, g.refund, g.fee, g.net, g.count]);
    });
    rows.push(['合計', a.total.gross, a.total.refund, a.total.fee, a.total.net, a.total.count]);
    sh.getRange(r, 1, rows.length, header.length).setValues(rows);
    sh.getRange(r, 2, rows.length, 4).setNumberFormat(YEN_FMT);
    sh.getRange(r + rows.length - 1, 1, 1, header.length).setFontWeight('bold').setBackground('#f2f6fc');
    r += rows.length + 1;

    // 月別推移（純額）
    const months = fiscalMonthOrder_();
    const mHeader = ['会計月'].concat(sources).concat(['合計']);
    sh.getRange(r, 1, 1, mHeader.length).setValues([mHeader]).setFontWeight('bold').setBackground('#eef7ee');
    r++;
    const mRows = months.map(function (m) {
      let total = 0;
      const row = [m + '月'];
      sources.forEach(function (s) {
        const v = (a.monthly[s] && a.monthly[s][m]) ? a.monthly[s][m] : 0;
        total += v;
        row.push(v);
      });
      row.push(total);
      return row;
    });
    sh.getRange(r, 1, mRows.length, mHeader.length).setValues(mRows);
    sh.getRange(r, 2, mRows.length, mHeader.length - 1).setNumberFormat(YEN_FMT);
    r += mRows.length + 2;
  });

  autoSize_(sh, 7);
}

/** === 事業別サマリー === */
function writeBusinessSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_BUSINESS);
  let r = 1;
  sh.getRange(r++, 1).setValue('事業別サマリー（各事業の入金）')
    .setFontWeight('bold').setFontSize(14);
  sh.getRange(r++, 1).setValue('「入金合計（純額）」＝手数料・返金を差し引いた、実際に入ってくる額です。');
  r++;

  if (!reports.fyList.length) {
    sh.getRange(r, 1).setValue('データがありません。');
    return;
  }

  reports.fyList.forEach(function (fy) {
    const byBiz = reports.business[fy];
    sh.getRange(r, 1).setValue('■ ' + fiscalYearLabel_(fy) + '（' + fiscalYearRangeLabel_(fy) + '）')
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    r++;

    const header = ['事業', 'Stripe入金', 'Komoju入金', '入金合計（純額）', '売上総額', '返金', '手数料'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;

    const bizNames = Object.keys(byBiz).sort(function (x, y) {
      return byBiz[y].total.net - byBiz[x].total.net;
    });
    const totals = { stripe: 0, komoju: 0, net: 0, gross: 0, refund: 0, fee: 0 };
    const rows = bizNames.map(function (name) {
      const rec = byBiz[name];
      const stripeNet = rec.bySource['Stripe'] ? rec.bySource['Stripe'].net : 0;
      const komojuNet = rec.bySource['Komoju'] ? rec.bySource['Komoju'].net : 0;
      totals.stripe += stripeNet; totals.komoju += komojuNet;
      totals.net += rec.total.net; totals.gross += rec.total.gross;
      totals.refund += rec.total.refund; totals.fee += rec.total.fee;
      return [name, stripeNet, komojuNet, rec.total.net, rec.total.gross, rec.total.refund, rec.total.fee];
    });
    rows.push(['合計', totals.stripe, totals.komoju, totals.net, totals.gross, totals.refund, totals.fee]);
    sh.getRange(r, 1, rows.length, header.length).setValues(rows);
    sh.getRange(r, 2, rows.length, 6).setNumberFormat(YEN_FMT);
    sh.getRange(r + rows.length - 1, 1, 1, header.length).setFontWeight('bold').setBackground('#f2f6fc');
    r += rows.length + 2;
  });

  autoSize_(sh, 7);
}

/** === 商品別売上（年度ごと） === */
function writeProductSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_PRODUCT);
  let r = 1;
  sh.getRange(r++, 1).setValue('商品別売上（年度ごと）').setFontWeight('bold').setFontSize(14);
  r++;
  if (!reports.fyList.length) { sh.getRange(r, 1).setValue('データがありません。'); return; }

  reports.fyList.forEach(function (fy) {
    sh.getRange(r++, 1).setValue('■ ' + fiscalYearLabel_(fy))
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    const header = ['決済', '商品／注文', '事業', '件数', '売上（総額）', '返金', '手数料', '純額'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const list = reports.byProduct[fy];
    const rows = list.map(function (x) {
      return [x.source, x.label, x.business || '未分類', x.agg.count, x.agg.gross, x.agg.refund, x.agg.fee, x.agg.net];
    });
    if (rows.length) {
      sh.getRange(r, 1, rows.length, header.length).setValues(rows);
      sh.getRange(r, 5, rows.length, 4).setNumberFormat(YEN_FMT);
      r += rows.length;
    }
    r += 2;
  });
  autoSize_(sh, 8);
}

/** === 決済手段別（年度ごと） === */
function writeMethodSheet_(ss, reports) {
  const sh = prepSheet_(ss, SHEETS.BY_METHOD);
  let r = 1;
  sh.getRange(r++, 1).setValue('決済手段別の内訳（年度ごと）').setFontWeight('bold').setFontSize(14);
  r++;
  if (!reports.fyList.length) { sh.getRange(r, 1).setValue('データがありません。'); return; }

  reports.fyList.forEach(function (fy) {
    sh.getRange(r++, 1).setValue('■ ' + fiscalYearLabel_(fy))
      .setFontWeight('bold').setFontSize(12).setFontColor('#1a56db');
    const header = ['決済', '決済手段', '件数', '売上（総額）', '返金', '純額'];
    sh.getRange(r, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
    r++;
    const list = reports.byMethod[fy];
    const rows = list.map(function (x) {
      return [x.source, x.label, x.agg.count, x.agg.gross, x.agg.refund, x.agg.net];
    });
    if (rows.length) {
      sh.getRange(r, 1, rows.length, header.length).setValues(rows);
      sh.getRange(r, 4, rows.length, 3).setNumberFormat(YEN_FMT);
      r += rows.length;
    }
    r += 2;
  });
  autoSize_(sh, 6);
}

/** === 入金照合 === */
function writeReconcileSheet_(ss, payouts) {
  const sh = prepSheet_(ss, SHEETS.RECONCILE);
  sh.getRange(1, 1).setValue('入金額との照合').setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setValue('各入金（振込）について、明細の純額合計と実際の入金額が一致するかを検算します。');
  const header = ['決済', '年度', '入金ID', '着金日', '実際の入金額', '明細の純額合計', '差額', '判定'];
  const hr = 4;
  sh.getRange(hr, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');

  const sorted = (payouts || []).slice().sort(function (a, b) {
    return b.arrivalDate.getTime() - a.arrivalDate.getTime();
  });
  const body = sorted.map(function (p) {
    const diff = p.payoutAmount - p.calculatedNet;
    const isKomoju = p.source === 'Komoju';
    // Komojuの純額は概算のため差額は出る。実際の入金額（payoutAmount）が正。
    const judge = isKomoju ? '実入金額（純額は概算）' : (Math.abs(diff) <= 1 ? '✓ 一致' : '要確認');
    return [
      p.source,
      fiscalYearLabel_(fiscalYearOf_(p.arrivalDate)),
      p.payoutId,
      Utilities.formatDate(p.arrivalDate, 'Asia/Tokyo', 'yyyy/MM/dd'),
      p.payoutAmount, p.calculatedNet, diff, judge,
    ];
  });
  if (body.length) {
    sh.getRange(hr + 1, 1, body.length, header.length).setValues(body);
    sh.getRange(hr + 1, 5, body.length, 3).setNumberFormat(YEN_FMT);
    for (let i = 0; i < body.length; i++) {
      if (body[i][7] === '要確認') {
        sh.getRange(hr + 1 + i, 1, 1, header.length).setBackground('#fdecea');
      }
    }
  } else {
    sh.getRange(hr + 1, 1).setValue('入金データがありません。');
  }
  autoSize_(sh, header.length);
}

function autoSize_(sh, numCols) {
  for (let c = 1; c <= numCols; c++) sh.autoResizeColumn(c);
}

/**
 * 会社提出用の明細シートを書き出す。
 * 列: source, date, yearMonth, type, product, gross, fee, net, payoutDate
 * 見出しは日本語。product は Komoju仕分けの内容も反映済み（buildReports_ で上書き済みの txns を渡す）。
 */
function writeSubmissionSheet_(ss, txns) {
  const sh = prepSheet_(ss, SHEETS.SUBMISSION);
  const header = ['決済サービス', '取引日', '対象月', '種別', '商品名', '事業', '売上（総額）', '手数料', '純額', '入金日'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eef7');
  sh.setFrozenRows(1);

  const sorted = (txns || []).slice().sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
  const rows = sorted.map(function (t) {
    return [
      t.source,
      Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy/MM/dd'),
      t.yearMonth || Utilities.formatDate(t.date, 'Asia/Tokyo', 'yyyy-MM'),
      t.type,
      t.product,
      t.business || '未分類',
      t.gross,
      t.fee,
      t.net,
      t.payoutDate ? Utilities.formatDate(t.payoutDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '',
    ];
  });
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 7, rows.length, 3).setNumberFormat(YEN_FMT); // 売上・手数料・純額
  }
  // 末尾の余分な空白行を削除（提出用に見た目を整える）
  const need = rows.length + 1;
  if (sh.getMaxRows() > need) sh.deleteRows(need + 1, sh.getMaxRows() - need);
  autoSize_(sh, header.length);
}
