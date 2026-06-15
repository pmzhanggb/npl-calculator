const QUARTERS = 20;
const QUARTERS_PER_YEAR = 4;

const defaults = {
  faceValue: 100000000,
  purchaseDiscount: 2.8,
  targetIrr: 25,
  year1QuarterlyRecovery: 1.05,
  year2QuarterlyRecovery: 0.72,
  year3QuarterlyRecovery: 0.48,
  year4QuarterlyRecovery: 0.30,
  year5QuarterlyRecovery: 0.18,
  equityRatio: 25,
  amcRatio: 55,
  mezzRatio: 20,
  amcRate: 8,
  mezzRate: 14,
  amcChannelFixed: 500000,
  amcChannelRate: 1.5,
  amcMgmtRate: 5,
  collectionFeeRate: 18,
  legalCostRate: 3,
  rebateRate: 2,
  monthlyOverhead: 80000,
};

const fields = Object.keys(defaults);
const form = document.querySelector("#modelForm");
const resetButton = document.querySelector("#resetButton");
const chart = document.querySelector("#trendChart");
const tooltipEl = document.querySelector("#chartTooltip");
const ctx = chart.getContext("2d");

let cachedResult = null;
let currentHoverIndex = -1;

const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

function percent(value, digits = 1) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

function multiple(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function priceRate(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function discountInZhe(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value / 10).toFixed(2)}折`;
}

function setDefaults() {
  fields.forEach((field) => {
    document.querySelector(`#${field}`).value = defaults[field];
  });
  updateModel();
}

function getInputs() {
  return fields.reduce((values, field) => {
    values[field] = Number(document.querySelector(`#${field}`).value) || 0;
    return values;
  }, {});
}

function recoveryRates(values, multiplier = 1) {
  return [
    values.year1QuarterlyRecovery,
    values.year2QuarterlyRecovery,
    values.year3QuarterlyRecovery,
    values.year4QuarterlyRecovery,
    values.year5QuarterlyRecovery,
  ].map((rate) => (rate / 100) * multiplier);
}

function financing(values) {
  const purchasePrice = values.faceValue * (values.purchaseDiscount / 100);
  const totalRatio = values.equityRatio + values.amcRatio + values.mezzRatio || 1;
  return {
    purchasePrice,
    equity: purchasePrice * (values.equityRatio / totalRatio),
    amc: purchasePrice * (values.amcRatio / totalRatio),
    mezz: purchasePrice * (values.mezzRatio / totalRatio),
  };
}

function project(values, options = {}) {
  const multiplier = options.recoveryMultiplier ?? 1;
  const funds = financing(values);
  const yearlyRates = recoveryRates(values, multiplier);
  const rows = [];
  const equityCashFlows = [-funds.equity];

  // AMC 一次性通道费：固定 + 对价 × 费率；首期一次性从劣后支出
  const channelFee = funds.amc > 0
    ? values.amcChannelFixed + funds.purchasePrice * (values.amcChannelRate / 100)
    : 0;
  if (channelFee > 0) {
    equityCashFlows.push(-channelFee);
  }

  let assetPrincipal = values.faceValue;
  let amcPrincipal = funds.amc;
  let mezzPrincipal = funds.mezz;
  let cumulativeEquityAsset = -funds.equity - channelFee;
  let cumulativeAmcRevenue = 0;
  let cumulativeMezzRevenue = 0;
  let cumulativeAmcPaid = 0;
  let cumulativeMezzPaid = 0;
  let cumulativeMezzPrincipalPaid = 0;
  let totalAmcPaid = 0;
  let totalMezzPaid = 0;
  let totalMezzPrincipalPaid = 0;
  let totalMezzInterestPaid = 0;
  let totalRebate = 0;
  let totalCosts = 0;
  let totalRecovery = 0;
  let totalMgmtFee = 0;
  let totalChannelFee = channelFee;
  let worstQuarterlyEquityCash = 0;
  let paybackQuarter = null;
  let amcPaybackQuarter = null;
  let mezzPaybackQuarter = null;

  for (let quarter = 1; quarter <= QUARTERS; quarter += 1) {
    const yearIndex = Math.min(Math.floor((quarter - 1) / QUARTERS_PER_YEAR), 4);
    const beginningAssetPrincipal = assetPrincipal;
    const quarterlyRate = yearlyRates[yearIndex];
    const grossRecovery = Math.min(assetPrincipal, beginningAssetPrincipal * quarterlyRate);
    assetPrincipal = Math.max(0, assetPrincipal - grossRecovery);

    const collectionFee = grossRecovery * (values.collectionFeeRate / 100);
    const legalCost = grossRecovery * (values.legalCostRate / 100);
    const distributable = Math.max(0, grossRecovery - collectionFee - legalCost);
    const rebate = grossRecovery * (values.rebateRate / 100);
    const mgmtFee = grossRecovery * (values.amcMgmtRate / 100);

    const amcInterestDue = amcPrincipal * (values.amcRate / 100 / QUARTERS_PER_YEAR);
    const amcPaid = Math.min(distributable, amcInterestDue + amcPrincipal);
    const amcInterestPaid = Math.min(amcPaid, amcInterestDue);
    const amcPrincipalPaid = Math.max(0, amcPaid - amcInterestPaid);
    amcPrincipal = Math.max(0, amcPrincipal - amcPrincipalPaid);

    const afterAmc = distributable - amcPaid;
    // Mezz 利息：按原始投入本金每季固定计提（T0 起算），劣后刚性兑付
    const mezzInterestDue =
      funds.mezz > 0 ? funds.mezz * (values.mezzRate / 100 / QUARTERS_PER_YEAR) : 0;
    // Mezz 本金：仅从当季可分配额中兑付
    const mezzPrincipalPaid = Math.min(afterAmc, mezzPrincipal);
    mezzPrincipal = Math.max(0, mezzPrincipal - mezzPrincipalPaid);

    const residual = Math.max(0, afterAmc - mezzPrincipalPaid);
    const quarterlyOverhead = values.monthlyOverhead * 3;
    // 劣后承担：剩余可分配 + 返点 − 季运营 − 季管理费 − Mezz 当季利息（刚性兑付）
    const equityCash = residual + rebate - quarterlyOverhead - mgmtFee - mezzInterestDue;
    cumulativeEquityAsset += equityCash;
    equityCashFlows.push(equityCash);

    // AMC 累计收益 = 利息 + 管理费（+ 首季一次性通道费）
    cumulativeAmcRevenue += amcInterestPaid + mgmtFee;
    if (quarter === 1 && channelFee > 0) {
      cumulativeAmcRevenue += channelFee;
    }
    // Mezz 累计收益 = 累计利息（劣后兜底）+ 累计本金偿还
    cumulativeMezzRevenue += mezzInterestDue + mezzPrincipalPaid;

    totalAmcPaid += amcPaid;
    totalMezzPaid += mezzPrincipalPaid;
    totalMezzPrincipalPaid += mezzPrincipalPaid;
    totalMezzInterestPaid += mezzInterestDue;
    totalRebate += rebate;
    totalCosts += collectionFee + legalCost + quarterlyOverhead + mgmtFee;
    totalRecovery += grossRecovery;
    totalMgmtFee += mgmtFee;
    worstQuarterlyEquityCash = Math.min(worstQuarterlyEquityCash, equityCash);

    cumulativeAmcPaid += amcPaid;
    cumulativeMezzPaid += mezzPrincipalPaid;
    cumulativeMezzPrincipalPaid += mezzPrincipalPaid;
    if (paybackQuarter === null && cumulativeEquityAsset >= 0) {
      paybackQuarter = quarter;
    }
    if (
      amcPaybackQuarter === null &&
      funds.amc > 0 &&
      cumulativeAmcPaid >= funds.amc
    ) {
      amcPaybackQuarter = quarter;
    }
    if (
      mezzPaybackQuarter === null &&
      funds.mezz > 0 &&
      cumulativeMezzPrincipalPaid >= funds.mezz
    ) {
      mezzPaybackQuarter = quarter;
    }

    rows.push({
      quarter,
      year: yearIndex + 1,
      quarterlyRate,
      beginningAssetPrincipal,
      grossRecovery,
      endingAssetPrincipal: assetPrincipal,
      collectionFee,
      legalCost,
      distributable,
      amcPaid,
      mezzPaid: mezzPrincipalPaid,
      mezzInterestDue,
      mezzPrincipalPaid,
      rebate,
      mgmtFee,
      equityCash,
      cumulativeEquityAsset,
      amcCumulativeRevenue: cumulativeAmcRevenue,
      mezzCumulativeRevenue: cumulativeMezzRevenue,
      cumulativeMezzPrincipalPaid,
      amcBalance: amcPrincipal,
      mezzBalance: mezzPrincipal,
      seniorBalance: amcPrincipal + mezzPrincipal,
    });
  }

  const irr = annualizedIrr(equityCashFlows);
  const equityProfit = cumulativeEquityAsset;
  const moic = funds.equity > 0 ? (funds.equity + equityProfit) / funds.equity : 0;
  const seniorObligation = funds.amc + funds.mezz;
  const seniorCoverage = seniorObligation > 0 ? (totalAmcPaid + totalMezzPaid) / seniorObligation : Infinity;

  return {
    rows,
    funds,
    equityCashFlows,
    irr,
    equityProfit,
    moic,
    paybackQuarter,
    amcPaybackQuarter,
    mezzPaybackQuarter,
    seniorCoverage,
    remainingSeniorPrincipal: amcPrincipal + mezzPrincipal,
    remainingAssetPrincipal: assetPrincipal,
    totalRecovery,
    totalAmcPaid,
    totalMezzPaid,
    totalMezzPrincipalPaid,
    totalMezzInterestPaid,
    totalRebate,
    totalMgmtFee,
    totalChannelFee,
    totalCosts,
    worstQuarterlyEquityCash,
  };
}

function annualizedIrr(cashFlows) {
  const npv = (rate) =>
    cashFlows.reduce((sum, cash, index) => sum + cash / Math.pow(1 + rate, index), 0);
  const roots = [];
  const minRate = -0.95;
  const maxRate = 20;
  const steps = 1800;
  let left = minRate;
  let leftValue = npv(left);

  for (let step = 1; step <= steps; step += 1) {
    const right = minRate + ((maxRate - minRate) * step) / steps;
    const rightValue = npv(right);
    if (leftValue === 0 || leftValue * rightValue < 0) {
      roots.push(solveRoot(left, right, npv));
    }
    left = right;
    leftValue = rightValue;
  }

  if (!roots.length) return NaN;
  const quarterlyRate = Math.max(...roots);
  return (Math.pow(1 + quarterlyRate, QUARTERS_PER_YEAR) - 1) * 100;
}

function solveRoot(low, high, fn) {
  let lowValue = fn(low);
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const midValue = fn(mid);
    if (lowValue * midValue <= 0) {
      high = mid;
    } else {
      low = mid;
      lowValue = midValue;
    }
  }
  return (low + high) / 2;
}

function findBreakEvenMultiplier(values) {
  return binarySearch(0, 5, (candidate) => {
    const result = project(values, { recoveryMultiplier: candidate });
    return result.equityProfit;
  });
}

function findMaxDiscount(values) {
  const low = 0.1;
  const high = 20;
  const score = (candidate) => {
    const result = project({ ...values, purchaseDiscount: candidate });
    return Number.isFinite(result.irr) ? result.irr - values.targetIrr : -999;
  };
  if (score(low) < 0) return NaN;
  if (score(high) >= 0) return high;

  let left = low;
  let right = high;
  for (let i = 0; i < 60; i += 1) {
    const mid = (left + right) / 2;
    if (score(mid) >= 0) {
      left = mid;
    } else {
      right = mid;
    }
  }
  return left;
}

function binarySearch(low, high, score) {
  const lowScore = score(low);
  const highScore = score(high);
  if (lowScore >= 0) return low;
  if (highScore < 0) return NaN;

  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (score(mid) >= 0) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

function classify(result, values) {
  if (
    Number.isFinite(result.irr) &&
    result.irr >= values.targetIrr &&
    result.equityProfit > 0 &&
    result.remainingSeniorPrincipal <= 1
  ) {
    return {
      label: "可以买",
      className: "good",
      note: "达到目标IRR，且优先级资金已清偿",
    };
  }

  if (result.remainingSeniorPrincipal <= 1 && result.equityProfit > 0) {
    return {
      label: "可谈价",
      className: "watch",
      note: "项目赚钱，但劣后收益未达到目标口径",
    };
  }

  return {
    label: "不建议",
    className: "risk",
    note: "优先级清偿或劣后收益存在明显压力",
  };
}

function renderMetrics(result, values) {
  const verdict = classify(result, values);
  const breakEven = findBreakEvenMultiplier(values);
  const maxDiscount = findMaxDiscount(values);
  const verdictCard = document.querySelector(".verdict-card");
  verdictCard.className = `metric-card verdict-card ${verdict.className}`;

  document.querySelector("#verdict").textContent = verdict.label;
  document.querySelector("#verdictNote").textContent = verdict.note;
  document.querySelector("#equityIrr").textContent = percent(result.irr);
  document.querySelector("#irrNote").textContent = `目标 ${percent(values.targetIrr, 0)}`;
  document.querySelector("#equityAsset").textContent = currency.format(result.equityProfit);
  document.querySelector("#moic").textContent = `MOIC ${Number.isFinite(result.moic) ? result.moic.toFixed(2) : "-"}x`;
  document.querySelector("#maxDiscount").textContent = Number.isFinite(maxDiscount)
    ? priceRate(maxDiscount)
    : "达不到";
  document.querySelector("#maxDiscountNote").textContent = Number.isFinite(maxDiscount)
    ? `约${discountInZhe(maxDiscount)}，按目标IRR反推`
    : "当前假设下无法达到目标IRR";
  document.querySelector("#breakEvenRecovery").textContent = Number.isFinite(breakEven)
    ? multiple(breakEven)
    : "未覆盖";
  document.querySelector("#seniorCoverage").textContent = Number.isFinite(result.seniorCoverage)
    ? `${result.seniorCoverage.toFixed(2)}x`
    : "无配资";
  document.querySelector("#coverageNote").textContent =
    result.remainingSeniorPrincipal <= 1
      ? "优先本金已清偿(Mezz利息由劣后承担)"
      : `剩余 ${currency.format(result.remainingSeniorPrincipal)}(Mezz利息由劣后承担)`;

  const paybackParts = [
    result.paybackQuarter !== null ? `劣后 Q${result.paybackQuarter}` : "劣后 未回本",
    result.amcPaybackQuarter !== null ? `AMC Q${result.amcPaybackQuarter}` : "AMC 未回本",
    result.mezzPaybackQuarter !== null ? `Mezz Q${result.mezzPaybackQuarter}` : "Mezz 未回本",
  ];
  document.querySelector("#paybackQuarters").textContent = paybackParts.join(" / ");
  const allRecovered =
    result.paybackQuarter !== null &&
    result.amcPaybackQuarter !== null &&
    result.mezzPaybackQuarter !== null;
  document.querySelector("#paybackNote").textContent = allRecovered
    ? "三参与方均在 5 年内回本"
    : "存在未回本参与方";
}

function renderInsights(result, values) {
  const breakEven = findBreakEvenMultiplier(values);
  const totalRecoveryRate = values.faceValue > 0 ? (result.totalRecovery / values.faceValue) * 100 : 0;
  const channelFee = result.totalChannelFee;
  const mgmtFee = result.totalMgmtFee;
  const amcRevenueRatio =
    result.funds.equity + result.equityProfit > 0 && channelFee + mgmtFee > 0
      ? ((channelFee + mgmtFee) / (result.funds.equity + result.equityProfit)) * 100
      : 0;
  const items = [
    {
      title: `购包价：${currency.format(result.funds.purchasePrice)}`,
      body: `当前价格率 ${priceRate(values.purchaseDiscount)}（约${discountInZhe(
        values.purchaseDiscount,
      )}），自有投入 ${currency.format(result.funds.equity)}，AMC配资 ${currency.format(
        result.funds.amc,
      )}，其他融资 ${currency.format(result.funds.mezz)}。`,
      tone: "good",
    },
    {
      title: `AMC一次性通道费：${currency.format(channelFee)}`,
      body: `= 固定 ${currency.format(values.amcChannelFixed)} + 对价 × ${
        priceRate(values.amcChannelRate)
      }，在购包首期一次性从劣后支出并计入 AMC 收益。`,
      tone: channelFee > 0 ? "warn" : "good",
    },
    {
      title: `5年AMC累计收益：${currency.format(
        result.rows[result.rows.length - 1].amcCumulativeRevenue,
      )}`,
      body: `含通道费 ${currency.format(channelFee)} + 累计利息 + 累计管理费 ${currency.format(
        mgmtFee,
      )}；管理费按每季回收额计提，从劣后扣除。`,
      tone: "good",
    },
    {
      title: `5年其他融资累计兑付：${currency.format(
        result.rows[result.rows.length - 1].mezzCumulativeRevenue,
      )}`,
      body: `= 累计本金偿还 ${currency.format(result.totalMezzPrincipalPaid)} + 累计利息 ${currency.format(
        result.totalMezzInterestPaid,
      )}；利息按原始配资本金每季固定计提，劣后刚性兑付（季付 ${currency.format(
        result.funds.mezz > 0
          ? result.funds.mezz * (values.mezzRate / 100 / QUARTERS_PER_YEAR)
          : 0,
      )}）。`,
      tone: "good",
    },
    {
      title: `劣后5年累计承担Mezz利息：${currency.format(result.totalMezzInterestPaid)}`,
      body: `已计入劣后现金流（按季扣除），与当季可分配额无关；这是 IRR 低于"利随本清"模型的主因。`,
      tone: result.totalMezzInterestPaid > 0 ? "warn" : "good",
    },
    {
      title: `5年累计回收：${currency.format(result.totalRecovery)}`,
      body: `约占原始账面本金的 ${percent(totalRecoveryRate)}，期末剩余资产本金 ${currency.format(
        result.remainingAssetPrincipal,
      )}。`,
      tone: totalRecoveryRate > values.purchaseDiscount ? "good" : "warn",
    },
    {
      title: `回收安全倍率：${Number.isFinite(breakEven) ? multiple(1 / breakEven) : "-"}`,
      body:
        Number.isFinite(breakEven) && breakEven <= 1
          ? "当前五年回收假设高于劣后盈亏平衡水平。"
          : "当前五年回收假设不足以覆盖劣后盈亏，需要压低价格或提高处置效率。",
      tone: Number.isFinite(breakEven) && breakEven <= 1 ? "good" : "bad",
    },
    {
      title: `返点贡献：${currency.format(result.totalRebate)}`,
      body: `返点按当季回收额计算，约占劣后累计收益的 ${
        result.equityProfit > 0 ? percent((result.totalRebate / result.equityProfit) * 100) : "-"
      }；AMC 综合费率(通道+管理)约 ${percent(amcRevenueRatio)}。`,
      tone: result.totalRebate > 0 ? "good" : "warn",
    },
  ];

  document.querySelector("#insights").innerHTML = items
    .map(
      (item) => `
        <div class="insight ${item.tone === "good" ? "" : item.tone}">
          <strong>${item.title}</strong>
          <span>${item.body}</span>
        </div>
      `,
    )
    .join("");
}

function renderTable(rows) {
  document.querySelector("#projectionRows").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>第 ${row.quarter} 季</td>
          <td>${currency.format(row.beginningAssetPrincipal)}</td>
          <td>${currency.format(row.grossRecovery)}</td>
          <td>${currency.format(row.endingAssetPrincipal)}</td>
          <td>${currency.format(row.amcCumulativeRevenue)}</td>
          <td>${currency.format(row.mezzCumulativeRevenue)}</td>
          <td class="${row.cumulativeEquityAsset >= 0 ? "positive" : "negative"}">${currency.format(
            row.cumulativeEquityAsset,
          )}</td>
          <td>${currency.format(row.rebate)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderSensitivity(values) {
  const recoveryMultipliers = [0.7, 0.85, 1, 1.15, 1.3];
  const discountFactors = [-0.6, -0.3, 0, 0.3, 0.6].map((delta) =>
    Math.max(0.1, values.purchaseDiscount + delta),
  );
  const cells = [`<div class="cell head">回收倍率 \\ 价格率</div>`];

  discountFactors.forEach((discount) => {
    cells.push(`<div class="cell head">${priceRate(discount)}</div>`);
  });

  recoveryMultipliers.forEach((multiplier) => {
    cells.push(`<div class="cell head">${multiple(multiplier)}</div>`);
    discountFactors.forEach((discount) => {
      const scenario = project(
        {
          ...values,
          purchaseDiscount: discount,
        },
        { recoveryMultiplier: multiplier },
      );
      const verdict = classify(scenario, values);
      cells.push(
        `<div class="cell ${verdict.className}" title="IRR ${percent(scenario.irr)}，劣后资产 ${currency.format(
          scenario.equityProfit,
        )}">${Number.isFinite(scenario.irr) ? percent(scenario.irr, 0) : "无解"}</div>`,
      );
    });
  });

  document.querySelector("#sensitivityGrid").innerHTML = cells.join("");
}

function drawChart(result) {
  const rows = result.rows;
  const dpr = window.devicePixelRatio || 1;
  const rect = chart.getBoundingClientRect();
  chart.width = Math.max(1, Math.floor(rect.width * dpr));
  chart.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const pad = { top: 18, right: 24, bottom: 36, left: 76 };
  const values = rows.flatMap((row) => [
    row.amcCumulativeRevenue,
    row.mezzCumulativeRevenue,
    row.cumulativeEquityAsset,
  ]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const x = (index) =>
    pad.left + (index / Math.max(rows.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value) =>
    pad.top + ((max - value) / span) * (height - pad.top - pad.bottom);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d9e1db";
  ctx.fillStyle = "#66736b";
  ctx.font = "12px Segoe UI, Microsoft YaHei, sans-serif";

  for (let i = 0; i <= 4; i += 1) {
    const value = min + (span * i) / 4;
    const lineY = y(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(width - pad.right, lineY);
    ctx.stroke();
    ctx.fillText(compactCurrency(value), 10, lineY + 4);
  }

  // 1) 盈亏平衡竖虚线（劣后 / AMC / Mezz）
  drawPaybackMarker(rows, x, y, result.paybackQuarter, "#1d8b5b", "劣后");
  drawPaybackMarker(rows, x, y, result.amcPaybackQuarter, "#b7771f", "AMC");
  drawPaybackMarker(rows, x, y, result.mezzPaybackQuarter, "#7c5aa6", "Mezz");

  // 2) 三条收益曲线
  drawLine(rows, x, y, "amcCumulativeRevenue", "#b7771f");
  drawLine(rows, x, y, "mezzCumulativeRevenue", "#7c5aa6");
  drawLine(rows, x, y, "cumulativeEquityAsset", "#1d8b5b");

  // 3) 0 轴线（劣后有可能从负起步）
  if (min < 0) {
    ctx.strokeStyle = "#9aa6a0";
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y(0));
    ctx.lineTo(width - pad.right, y(0));
    ctx.stroke();
  }

  // 4) 横轴标签
  ctx.fillStyle = "#66736b";
  [1, 4, 8, 12, 16, 20].forEach((quarter) => {
    ctx.fillText(`Q${quarter}`, x(quarter - 1) - 10, height - 12);
  });

  // 5) Hover 高亮层
  if (currentHoverIndex >= 0 && currentHoverIndex < rows.length) {
    drawHoverOverlay(rows, x, y, currentHoverIndex);
  }
}

function drawPaybackMarker(rows, x, y, paybackQuarter, color, label) {
  if (!paybackQuarter || paybackQuarter < 1 || paybackQuarter > rows.length) return;
  const px = x(paybackQuarter - 1);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 18);
  ctx.lineTo(px, 18 + (chart.getBoundingClientRect().height - 18 - 36));
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.font = "10px Segoe UI, Microsoft YaHei, sans-serif";
  const tag = `${label}Q${paybackQuarter}`;
  const tagWidth = ctx.measureText(tag).width + 8;
  ctx.fillStyle = color;
  ctx.fillRect(px - tagWidth / 2, 1, tagWidth, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tag, px - tagWidth / 2 + 4, 12);
  ctx.restore();
}

function drawHoverOverlay(rows, x, y, index) {
  const row = rows[index];
  const px = x(index);
  const innerTop = 18;
  const rect = chart.getBoundingClientRect();
  const innerBottom = rect.height - 36;

  // 竖虚线
  ctx.save();
  ctx.strokeStyle = "#17201b";
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, innerTop);
  ctx.lineTo(px, innerBottom);
  ctx.stroke();
  ctx.restore();

  // 三个参与方高亮点
  const points = [
    { key: "amcCumulativeRevenue", color: "#b7771f" },
    { key: "mezzCumulativeRevenue", color: "#7c5aa6" },
    { key: "cumulativeEquityAsset", color: "#1d8b5b" },
  ];
  points.forEach(({ key, color }) => {
    ctx.beginPath();
    ctx.arc(px, y(row[key]), 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  });
}

function showChartTooltip(row, clientX, clientY) {
  const initialOffset = -(cachedResult.funds.equity + cachedResult.totalChannelFee);
  const priorCumulative =
    row.quarter === 1
      ? initialOffset
      : cachedResult.rows[row.quarter - 2].cumulativeEquityAsset;
  const equityDelta = row.cumulativeEquityAsset - priorCumulative;

  tooltipEl.innerHTML = `
    <div class="tt-quarter">第 ${row.quarter} 季 · 第 ${row.year} 年</div>
    <div class="tt-row"><span class="tt-dot tt-amc"></span>AMC累计收益<span class="tt-value">${currency.format(
      row.amcCumulativeRevenue,
    )}</span></div>
    <div class="tt-row"><span class="tt-dot tt-mezz"></span>其他融资累计兑付<span class="tt-value">${currency.format(
      row.mezzCumulativeRevenue,
    )}</span></div>
    <div class="tt-row"><span class="tt-dot tt-equity"></span>劣后累计收益<span class="tt-value ${row.cumulativeEquityAsset >= 0 ? "tt-positive" : "tt-negative"}">${currency.format(
      row.cumulativeEquityAsset,
    )}</span></div>
    <div class="tt-row tt-delta">当季劣后分录<span class="tt-value">${
      equityDelta >= 0 ? "+" : ""
    }${currency.format(equityDelta)}</span></div>
    <div class="tt-divider"></div>
    <div class="tt-row">当季回收<span class="tt-value">${currency.format(row.grossRecovery)}</span></div>
    <div class="tt-row">当季Mezz利息(劣后付)<span class="tt-value">${currency.format(
      row.mezzInterestDue,
    )}</span></div>
    <div class="tt-row">剩余资产本金<span class="tt-value">${currency.format(
      row.endingAssetPrincipal,
    )}</span></div>
  `;

  tooltipEl.hidden = false;
  const wrap = chart.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const localX = clientX - wrapRect.left;
  const localY = clientY - wrapRect.top;
  const ttRect = tooltipEl.getBoundingClientRect();
  const ttWidth = ttRect.width;
  const ttHeight = ttRect.height;

  let left = localX + 16;
  if (left + ttWidth > wrapRect.width - 4) {
    left = localX - ttWidth - 16;
  }
  let top = localY - ttHeight - 14;
  if (top < 4) top = localY + 16;

  tooltipEl.style.left = `${Math.max(4, left)}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideChartTooltip() {
  tooltipEl.hidden = true;
}

function handleChartHover(event) {
  if (!cachedResult) return;
  const rect = chart.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const pad = { left: 76, right: 24 };
  if (localX < pad.left || localX > rect.width - pad.right) {
    if (currentHoverIndex !== -1) {
      currentHoverIndex = -1;
      drawChart(cachedResult);
      hideChartTooltip();
    }
    return;
  }
  const innerWidth = rect.width - pad.left - pad.right;
  const rowsLen = cachedResult.rows.length;
  const idx = Math.round(((localX - pad.left) / innerWidth) * (rowsLen - 1));
  const clamped = Math.max(0, Math.min(rowsLen - 1, idx));
  if (clamped !== currentHoverIndex) {
    currentHoverIndex = clamped;
    drawChart(cachedResult);
  }
  showChartTooltip(cachedResult.rows[currentHoverIndex], event.clientX, event.clientY);
}

function handleChartLeave() {
  if (currentHoverIndex !== -1) {
    currentHoverIndex = -1;
    if (cachedResult) drawChart(cachedResult);
  }
  hideChartTooltip();
}

chart.addEventListener("mousemove", handleChartHover);
chart.addEventListener("mouseleave", handleChartLeave);

function drawLine(rows, x, y, key, color) {
  ctx.beginPath();
  rows.forEach((row, index) => {
    const pointX = x(index);
    const pointY = y(row[key]);
    if (index === 0) {
      ctx.moveTo(pointX, pointY);
    } else {
      ctx.lineTo(pointX, pointY);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();

  rows.forEach((row, index) => {
    if (index === 0 || index === rows.length - 1 || (index + 1) % 4 === 0) {
      ctx.beginPath();
      ctx.arc(x(index), y(row[key]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  });
}

function compactCurrency(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(1)}亿`;
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万`;
  return `${sign}${number.format(abs)}`;
}

function updateModel() {
  const values = getInputs();
  const result = project(values);
  cachedResult = result;
  if (currentHoverIndex >= result.rows.length) currentHoverIndex = -1;
  renderMetrics(result, values);
  renderInsights(result, values);
  renderTable(result.rows);
  renderSensitivity(values);
  drawChart(result);
}

form.addEventListener("input", updateModel);
resetButton.addEventListener("click", setDefaults);
window.addEventListener("resize", updateModel);

// ============ 历史记录（LocalStorage 持久化） ============

const HISTORY_KEY = "npl_model_history_v1";
const MAX_HISTORY = 30;

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("读取历史记录失败：", err);
    return [];
  }
}

function writeHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    return true;
  } catch (err) {
    alert("保存失败：浏览器存储可能被禁用或配额已满。");
    console.error(err);
    return false;
  }
}

function defaultSnapshotName(values) {
  const yi = (values.faceValue / 100000000).toFixed(2);
  return `${yi}亿·${values.purchaseDiscount}折`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarizeValues(values) {
  return [
    `${(values.faceValue / 100000000).toFixed(2)}亿`,
    `${values.purchaseDiscount}折`,
    `AMC ${values.amcRate}%`,
    `劣后${values.equityRatio}%`,
    `目标IRR ${values.targetIrr}%`,
  ].join(" · ");
}

function saveCurrentSnapshot() {
  const values = getInputs();
  const suggested = defaultSnapshotName(values);
  const name = prompt("为这组参数命名（留空则用默认名称）：", suggested);
  if (name === null) return; // 用户取消
  const items = getHistory();
  const entry = {
    id: `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || suggested,
    timestamp: Date.now(),
    values,
  };
  items.unshift(entry);
  if (items.length > MAX_HISTORY) items.length = MAX_HISTORY;
  if (writeHistory(items)) {
    renderHistoryList();
    flashHistoryButton("已保存");
  }
}

function loadSnapshot(id) {
  const item = getHistory().find((entry) => entry.id === id);
  if (!item) return;
  const ok = confirm(`加载"${item.name}"将覆盖当前参数，继续吗？`);
  if (!ok) return;
  fields.forEach((field) => {
    const input = document.querySelector(`#${field}`);
    if (input && item.values[field] !== undefined) {
      input.value = item.values[field];
    }
  });
  updateModel();
}

function deleteSnapshot(id) {
  const item = getHistory().find((entry) => entry.id === id);
  if (!item) return;
  const ok = confirm(`确定删除"${item.name}"吗？此操作不可撤销。`);
  if (!ok) return;
  writeHistory(getHistory().filter((entry) => entry.id !== id));
  renderHistoryList();
}

function clearAllSnapshots() {
  const items = getHistory();
  if (!items.length) return;
  const ok = confirm(`确定清空全部 ${items.length} 条历史记录吗？此操作不可撤销。`);
  if (!ok) return;
  writeHistory([]);
  renderHistoryList();
}

function toggleHistoryPanel() {
  const panel = document.querySelector("#historyPanel");
  panel.hidden = !panel.hidden;
}

function flashHistoryButton(text) {
  const btn = document.querySelector("#saveHistoryButton");
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="btn-icon" aria-hidden="true">✓</span> ${text}`;
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, 1200);
}

function renderHistoryList() {
  const items = getHistory();
  const listEl = document.querySelector("#historyList");
  const countEl = document.querySelector("#historyCount");
  countEl.textContent = String(items.length);
  countEl.classList.toggle("is-empty", items.length === 0);

  if (!items.length) {
    listEl.innerHTML = `<div class="history-empty">还没有保存的快照。点击"保存当前"记录一组参数，刷新或关闭浏览器后仍可恢复。</div>`;
    return;
  }

  listEl.innerHTML = items
    .map(
      (item) => `
        <div class="history-item" data-id="${item.id}">
          <div class="history-item-main">
            <strong class="history-item-name">${escapeHtml(item.name)}</strong>
            <span class="history-item-meta">${escapeHtml(summarizeValues(item.values))}</span>
            <span class="history-item-time">${escapeHtml(formatTimestamp(item.timestamp))}</span>
          </div>
          <div class="history-item-actions">
            <button class="text-button" data-action="load" data-id="${item.id}">加载</button>
            <button class="text-button danger" data-action="delete" data-id="${item.id}">删除</button>
          </div>
        </div>
      `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

document.querySelector("#saveHistoryButton").addEventListener("click", saveCurrentSnapshot);
document.querySelector("#toggleHistoryButton").addEventListener("click", toggleHistoryPanel);
document.querySelector("#clearHistoryButton").addEventListener("click", clearAllSnapshots);
document.querySelector("#historyList").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === "load") loadSnapshot(id);
  else if (btn.dataset.action === "delete") deleteSnapshot(id);
});

renderHistoryList();

setDefaults();
