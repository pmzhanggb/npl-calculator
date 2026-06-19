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
  discountRecoveryRate: 0,
};

const fields = Object.keys(defaults);
const form = document.querySelector("#modelForm");
const resetButton = document.querySelector("#resetButton");
const chart = document.querySelector("#cashflowChart");
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
  // AMC 累计净收益起点 = T0 配资出, 循环结束 = Q20 累计 = 卡片"累计净收益"
  let cumulativeAmcRevenue = -funds.amc;
  // Mezz 累计净收益起点 = T0 配资出, 循环结束 = Q20 累计 = 卡片"累计净收益"
  let cumulativeMezzRevenue = -funds.mezz;
  let cumulativeMezzInterest = -funds.mezz;
  let cumulativeAmcPaid = 0;
  let cumulativeMezzPaid = 0;
  let cumulativeMezzPrincipalPaid = 0;
  let totalAmcPaid = 0;
  let totalMezzPaid = 0;
  let totalMezzPrincipalPaid = 0;
  let totalMezzInterestPaid = 0;
  let totalAmcInterestPaid = 0;
  let totalAmcPrincipalPaid = 0;
  let totalRecoveryShare = 0;
  let totalResidual = 0;
  let totalRebate = 0;
  let totalCosts = 0;
  let totalRecovery = 0;
  let totalMgmtFee = 0;
  let totalOverhead = 0;
  let totalChannelFee = channelFee;
  let totalWritedown = 0;
  let worstQuarterlyEquityCash = 0;
  let paybackQuarter = null;
  let amcPaybackQuarter = null;
  let mezzPaybackQuarter = null;

  for (let quarter = 1; quarter <= QUARTERS; quarter += 1) {
    const yearIndex = Math.min(Math.floor((quarter - 1) / QUARTERS_PER_YEAR), 4);
    const beginningAssetPrincipal = assetPrincipal;
    const quarterlyRate = yearlyRates[yearIndex];
    const grossRecovery = Math.min(assetPrincipal, beginningAssetPrincipal * quarterlyRate);
    // 打折回收：实际回款不变, 但账面本金额外抹销 X%
    const discountRate = (values.discountRecoveryRate || 0) / 100;
    const effectiveWritedown = grossRecovery * (1 + discountRate);
    assetPrincipal = Math.max(0, assetPrincipal - effectiveWritedown);
    totalWritedown += grossRecovery * discountRate;

    const collectionFee = grossRecovery * (values.collectionFeeRate / 100);
    const legalCost = grossRecovery * (values.legalCostRate / 100);
    const mgmtFee = grossRecovery * (values.amcMgmtRate / 100);
    // AMC 管理费从回收款中预扣，不从劣后垫付
    const distributable = Math.max(0, grossRecovery - collectionFee - legalCost - mgmtFee);
    const rebate = grossRecovery * (values.rebateRate / 100);
    const quarterlyOverhead = values.monthlyOverhead * 3;

    const amcInterestDue = amcPrincipal * (values.amcRate / 100 / QUARTERS_PER_YEAR);
    const amcPaid = Math.min(distributable, amcInterestDue + amcPrincipal);
    const amcInterestPaid = Math.min(amcPaid, amcInterestDue);
    const amcPrincipalPaid = Math.max(0, amcPaid - amcInterestPaid);
    amcPrincipal = Math.max(0, amcPrincipal - amcPrincipalPaid);

    const afterAmc = distributable - amcPaid;
    // Mezz 利息：按当期剩余本金计提（利随本清），劣后刚性兑付（与可分配额无关）
    const mezzInterestDue =
      mezzPrincipal > 0 ? mezzPrincipal * (values.mezzRate / 100 / QUARTERS_PER_YEAR) : 0;
    // Mezz 本金：仅从可分配额中兑付
    const mezzPrincipalPaid = Math.min(afterAmc, mezzPrincipal);
    mezzPrincipal = Math.max(0, mezzPrincipal - mezzPrincipalPaid);

    const residual = Math.max(0, afterAmc - mezzPrincipalPaid);
    // 劣后承担：剩余可分配 + 返点 − 季运营 − Mezz 当季利息（刚性兑付，付不起也照扣）
    // AMC 管理费已从回收款预扣，不再从劣后扣除
    const equityCash = residual + rebate - quarterlyOverhead - mezzInterestDue;
    cumulativeEquityAsset += equityCash;
    equityCashFlows.push(equityCash);

    // AMC 累计净收益 = 利息 + 管理费 + 本金偿还（+ 首季一次性通道费）
    cumulativeAmcRevenue += amcInterestPaid + mgmtFee + amcPrincipalPaid;
    if (quarter === 1 && channelFee > 0) {
      cumulativeAmcRevenue += channelFee;
    }
    // Mezz 累计净收益 = 利息（劣后兜底）+ 本金偿还
    cumulativeMezzRevenue += mezzInterestDue + mezzPrincipalPaid;
    // Mezz 累计收益（仅利息，不含本金偿还）
    cumulativeMezzInterest += mezzInterestDue;

    totalAmcPaid += amcPaid;
    totalAmcInterestPaid += amcInterestPaid;
    totalAmcPrincipalPaid += amcPrincipalPaid;
    totalMezzPaid += mezzPrincipalPaid;
    totalMezzPrincipalPaid += mezzPrincipalPaid;
    totalMezzInterestPaid += mezzInterestDue;
    totalRecoveryShare += residual + rebate;
    totalResidual += residual;
    totalRebate += rebate;
    totalCosts += collectionFee + legalCost + quarterlyOverhead + mgmtFee;
    totalRecovery += grossRecovery;
    totalMgmtFee += mgmtFee;
    totalOverhead += quarterlyOverhead;
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
      amcInterestPaid,
      amcPrincipalPaid,
      amcPaid,
      mezzInterestDue,
      mezzPrincipalPaid,
      mezzPaid: mezzPrincipalPaid,
      rebate,
      mgmtFee,
      quarterlyOverhead,
      residual,
      recoveryShare: residual + rebate,
      equityCash,
      cumulativeEquityAsset,
      amcCumulativeRevenue: cumulativeAmcRevenue,
      mezzCumulativeRevenue: cumulativeMezzRevenue,
      mezzCumulativeInterest: cumulativeMezzInterest,
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

  // AMC 现金流：T0 配资出 → 后续每季利息 + 管理费 + 本金偿还 + 首季通道费
  const amcCashFlows = funds.amc > 0 ? [-funds.amc] : [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    let inflow = r.amcInterestPaid + r.mgmtFee + r.amcPrincipalPaid;
    if (i === 0 && channelFee > 0) inflow += channelFee;
    amcCashFlows.push(inflow);
  }
  const amcIrr = funds.amc > 0 ? annualizedIrr(amcCashFlows) : NaN;
  const amcTotalRevenue = channelFee + totalAmcInterestPaid + totalMgmtFee + totalAmcPrincipalPaid;
  // AMC 净收益：直接用累计终值（已含 T0 负出资），保证 DETAIL 表 Q20 = 卡片
  const amcNetProfit = funds.amc > 0 ? cumulativeAmcRevenue : 0;
  const amcMoic = funds.amc > 0 ? amcTotalRevenue / funds.amc : 0;
  const amcRoi = funds.amc > 0 ? ((amcNetProfit / funds.amc) / 5) * 100 : NaN;

  // Mezz 现金流：T0 配资出 → 后续每季应收利息（劣后刚性兑付）+ 本金偿还
  const mezzCashFlows = funds.mezz > 0 ? [-funds.mezz] : [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    mezzCashFlows.push(r.mezzInterestDue + r.mezzPrincipalPaid);
  }
  const mezzIrr = funds.mezz > 0 ? annualizedIrr(mezzCashFlows) : NaN;
  const mezzTotalRevenue = totalMezzInterestPaid + totalMezzPrincipalPaid;
  // Mezz 净收益：直接用累计终值（已含 T0 负出资）
  const mezzNetProfit = funds.mezz > 0 ? cumulativeMezzRevenue : 0;
  const mezzMoic = funds.mezz > 0 ? mezzTotalRevenue / funds.mezz : 0;
  const mezzRoi = funds.mezz > 0 ? ((mezzNetProfit / funds.mezz) / 5) * 100 : NaN;

  return {
    rows,
    funds,
    equityCashFlows,
    amcCashFlows,
    mezzCashFlows,
    faceValue: values.faceValue,
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
    totalAmcInterestPaid,
    totalAmcPrincipalPaid,
    totalMezzPaid,
    totalMezzPrincipalPaid,
    totalMezzInterestPaid,
    totalResidual,
    totalRebate,
    totalMgmtFee,
    totalOverhead,
    totalChannelFee,
    amcTotalRevenue,
    amcNetProfit,
    amcMoic,
    amcIrr,
    amcRoi,
    mezzTotalRevenue,
    mezzNetProfit,
    mezzMoic,
    mezzIrr,
    mezzRoi,
    totalCosts,
    worstQuarterlyEquityCash,
    amcTotalRevenue,
    amcRoi,
    mezzRoi,
    totalWritedown,
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

// ============ 参与方卡渲染 ============

function renderMetrics(result, values) {
  const verdict = classify(result, values);
  const banner = document.querySelector("#verdictBanner");
  banner.className = `verdict-banner ${verdict.className}`;

  document.querySelector("#verdict").textContent = verdict.label;
  document.querySelector("#verdictNote").textContent = verdict.note;

  // AMC 卡
  document.querySelector("#amcInitialOut").textContent = `−${currency.format(result.funds.amc)}`;
  document.querySelector("#amcChannelFeeLine").textContent = currency.format(result.totalChannelFee);
  document.querySelector("#amcInterestLine").textContent = currency.format(result.totalAmcInterestPaid);
  document.querySelector("#amcMgmtLine").textContent = currency.format(result.totalMgmtFee);
  document.querySelector("#amcPrincipalLine").textContent = currency.format(result.totalAmcPrincipalPaid);
  document.querySelector("#amcNetProfit").textContent = currency.format(result.amcNetProfit);
  document.querySelector("#amcIrr").textContent = percent(result.amcIrr);
  document.querySelector("#amcMoic").textContent = Number.isFinite(result.amcMoic)
    ? `${result.amcMoic.toFixed(2)}x`
    : "-";
  document.querySelector("#amcRoi").textContent = Number.isFinite(result.amcRoi)
    ? percent(result.amcRoi, 1)
    : "无配资";
  document.querySelector("#amcPayback").textContent =
    result.amcPaybackQuarter !== null
      ? `Q${result.amcPaybackQuarter}`
      : result.funds.amc > 0
        ? "5年未回本"
        : "无配资";

  // Mezz 卡
  document.querySelector("#mezzInitialOut").textContent = `−${currency.format(result.funds.mezz)}`;
  document.querySelector("#mezzInterestLine").textContent = currency.format(result.totalMezzInterestPaid);
  document.querySelector("#mezzPrincipalLine").textContent = currency.format(result.totalMezzPrincipalPaid);
  document.querySelector("#mezzNetProfit").textContent = currency.format(result.mezzNetProfit);
  document.querySelector("#mezzIrr").textContent = percent(result.mezzIrr);
  document.querySelector("#mezzMoic").textContent = Number.isFinite(result.mezzMoic)
    ? `${result.mezzMoic.toFixed(2)}x`
    : "-";
  document.querySelector("#mezzRoi").textContent = Number.isFinite(result.mezzRoi)
    ? percent(result.mezzRoi, 1)
    : "无配资";
  document.querySelector("#mezzPayback").textContent =
    result.mezzPaybackQuarter !== null
      ? `Q${result.mezzPaybackQuarter}`
      : result.funds.mezz > 0
        ? "5年未回本"
        : "无配资";

  // 劣后卡
  document.querySelector("#equityInitialOut").textContent = `−${currency.format(result.funds.equity)}`;
  document.querySelector("#equityChannelFee").textContent = `−${currency.format(result.totalChannelFee)}`;
  document.querySelector("#equityRecoveryShare").textContent = `+${currency.format(result.totalResidual)}`;
  document.querySelector("#equityRebate").textContent = `+${currency.format(result.totalRebate)}`;
  document.querySelector("#equityOverhead").textContent = `−${currency.format(result.totalOverhead)}`;
  document.querySelector("#equityMezzInterest").textContent = `−${currency.format(result.totalMezzInterestPaid)}`;
  document.querySelector("#equityNetProfit").textContent = currency.format(result.equityProfit);
  document.querySelector("#equityIrr").textContent = percent(result.irr);
  document.querySelector("#equityMoic").textContent = Number.isFinite(result.moic)
    ? `${result.moic.toFixed(2)}x`
    : "-";
  document.querySelector("#equityPayback").textContent =
    result.paybackQuarter !== null
      ? `Q${result.paybackQuarter}`
      : "5年未回本";
}

// ============ 5 年资金流向总览 ============

function renderFlowOverview(result, values) {
  const container = document.querySelector("#flowDiagram");
  const recovery = result.totalRecovery;
  // 优先级总兑付 = AMC 累计实收 + Mezz 累计实收
  const amcCashReceived = result.totalChannelFee + result.totalAmcInterestPaid + result.totalMgmtFee + result.totalAmcPrincipalPaid;
  const mezzCashReceived = result.totalMezzInterestPaid + result.totalMezzPrincipalPaid;
  // 劣后净分配 = 5 年累计净分录 + 初始出资 + 通道费（含返点）
  const equityNet = result.equityProfit + result.funds.equity + result.totalChannelFee;

  // 外流成本：催收 + 诉讼 + 运营（AMC 管理费已不再外流，从回收款预扣）
  let collectionAndLegal = 0;
  for (const row of result.rows) collectionAndLegal += row.collectionFee + row.legalCost;
  const externalCost = collectionAndLegal + result.totalOverhead;

  // 优先级兑付（合计）= AMC 实收 + Mezz 实收
  const priorityTotal = amcCashReceived + mezzCashReceived;

  // 渲染 4 段：源 → 回收 → 三去向（AMC 兑付 / Mezz 兑付 / 劣后净分 / 外流）
  container.innerHTML = `
    <div class="flow-node flow-source-node">
      <span class="flow-label">资产本金</span>
      <span class="flow-value">${currency.format(values.faceValue)}</span>
    </div>
    <span class="flow-arrow">→</span>
    <div class="flow-node flow-recovery-node">
      <span class="flow-label">5年累计回收</span>
      <span class="flow-value">${currency.format(recovery)}</span>
      <small>${percent((recovery / values.faceValue) * 100, 1)} 账面本金</small>
    </div>
    <span class="flow-arrow">→</span>
    <div class="flow-branches">
      <div class="flow-branch flow-branch-amc">
        <span class="flow-label">AMC 兑付</span>
        <span class="flow-value">${currency.format(amcCashReceived)}</span>
        <small>通道费 ${currency.format(result.totalChannelFee)} + 利息 ${currency.format(result.totalAmcInterestPaid)} + 管理费 ${currency.format(result.totalMgmtFee)} + 本金 ${currency.format(result.totalAmcPrincipalPaid)}</small>
      </div>
      <div class="flow-branch flow-branch-mezz">
        <span class="flow-label">Mezz 兑付</span>
        <span class="flow-value">${currency.format(mezzCashReceived)}</span>
        <small>利息 ${currency.format(result.totalMezzInterestPaid)} + 本金 ${currency.format(result.totalMezzPrincipalPaid)}</small>
      </div>
      <div class="flow-branch flow-branch-equity">
        <span class="flow-label">劣后净分配</span>
        <span class="flow-value">${currency.format(equityNet)}</span>
        <small>含返点 ${currency.format(result.totalRebate)}</small>
      </div>
      <div class="flow-branch flow-branch-cost">
        <span class="flow-label">外流成本</span>
        <span class="flow-value">${currency.format(externalCost)}</span>
        <small>催收/诉讼 ${currency.format(collectionAndLegal)} + 运营 ${currency.format(result.totalOverhead)}</small>
      </div>
    </div>
  `;
  // 静默使用 priorityTotal（调试/校验用）
  void priorityTotal;
}

// ============ 季度现金分配瀑布图（分组柱状图） ============

function buildCashflowSeries(result) {
  const series = [];
  // Q0：三方配资出（仅配资，无通道费；通道费计入 Q1）
  series.push({
    index: 0,
    label: "Q0",
    quarter: 0,
    amc: -result.funds.amc,
    mezz: -result.funds.mezz,
    equity: -result.funds.equity,
    isInitial: true,
  });
  // Q1..Q20
  result.rows.forEach((row, idx) => {
    // AMC 现金流 = 利息 + 管理费 + 本金偿还 + 首季一次性通道费
    const amcFlow = row.amcInterestPaid + row.mgmtFee + row.amcPrincipalPaid + (row.quarter === 1 ? result.totalChannelFee : 0);
    // Mezz 现金流 = 应收利息（劣后刚性兑付）+ 本金偿还
    const mezzFlow = row.mezzInterestDue + row.mezzPrincipalPaid;
    // 劣后 Q1 净分录 = row.equityCash − 一次性通道费（与 IRR 现金流 22 期口径一致）
    const equityFlow = row.quarter === 1 ? row.equityCash - result.totalChannelFee : row.equityCash;
    series.push({
      index: idx + 1,
      label: `Q${row.quarter}`,
      quarter: row.quarter,
      amc: amcFlow,
      mezz: mezzFlow,
      equity: equityFlow,
      isInitial: false,
      row,
    });
  });
  return series;
}

function drawCashflowChart(result) {
  const series = buildCashflowSeries(result);
  const dpr = window.devicePixelRatio || 1;
  const rect = chart.getBoundingClientRect();
  chart.width = Math.max(1, Math.floor(rect.width * dpr));
  chart.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const pad = { top: 24, right: 18, bottom: 38, left: 84 };

  // 计算 Y 轴范围（正负都考虑）
  let maxAbs = 0;
  series.forEach((s) => {
    maxAbs = Math.max(maxAbs, Math.abs(s.amc), Math.abs(s.mezz), Math.abs(s.equity));
  });
  if (maxAbs < 1) maxAbs = 1;
  const max = maxAbs;
  const min = -maxAbs;
  const span = max - min || 1;

  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const groupWidth = innerWidth / series.length;
  const barWidth = Math.max(2, Math.min(14, (groupWidth - 6) / 3));
  const gap = 1.5;

  const xGroup = (index) => pad.left + index * groupWidth + groupWidth / 2;
  const yValue = (value) => pad.top + ((max - value) / span) * innerHeight;
  const yZero = yValue(0);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 水平网格
  ctx.strokeStyle = "#eef2ef";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66736b";
  ctx.font = "11px Segoe UI, Microsoft YaHei, sans-serif";
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i += 1) {
    const value = min + (span * i) / gridSteps;
    const lineY = yValue(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, lineY);
    ctx.lineTo(width - pad.right, lineY);
    ctx.stroke();
    ctx.fillText(compactCurrency(value), 8, lineY + 4);
  }

  // 0 轴（加粗）
  ctx.strokeStyle = "#9aa6a0";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, yZero);
  ctx.lineTo(width - pad.right, yZero);
  ctx.stroke();

  // 柱状图：每组 3 根（AMC 橙 / Mezz 紫 / Equity 绿）
  const colors = { amc: "#b7771f", mezz: "#7c5aa6", equity: "#1d8b5b" };
  series.forEach((s) => {
    const cx = xGroup(s.index);
    const offsets = [-barWidth - gap, 0, barWidth + gap];
    const keys = ["amc", "mezz", "equity"];
    keys.forEach((key, i) => {
      const value = s[key];
      if (Math.abs(value) < 0.5) return;
      const x = cx + offsets[i] - barWidth / 2;
      const yTop = yValue(Math.max(0, value));
      const yBot = yValue(Math.min(0, value));
      const barHeight = Math.max(1, yBot - yTop);
      ctx.fillStyle = colors[key];
      ctx.fillRect(x, yTop, barWidth, barHeight);
    });
  });

  // X 轴标签
  ctx.fillStyle = "#66736b";
  const labelQuarters = [0, 1, 4, 8, 12, 16, 20];
  labelQuarters.forEach((q) => {
    const s = series.find((x) => x.quarter === q);
    if (!s) return;
    const cx = xGroup(s.index);
    ctx.fillText(`Q${q}`, cx - 10, height - 16);
  });

  // hover 高亮
  if (currentHoverIndex >= 0 && currentHoverIndex < series.length) {
    drawCashflowHover(series, xGroup, yValue);
  }
}

function drawCashflowHover(series, xGroup, yValue) {
  const s = series[currentHoverIndex];
  const cx = xGroup(s.index);
  ctx.save();
  ctx.strokeStyle = "#17201b";
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 24);
  ctx.lineTo(cx, chart.getBoundingClientRect().height - 38);
  ctx.stroke();
  ctx.restore();

  // 三个高亮小圆
  const colors = { amc: "#b7771f", mezz: "#7c5aa6", equity: "#1d8b5b" };
  ["amc", "mezz", "equity"].forEach((key) => {
    const value = s[key];
    if (Math.abs(value) < 0.5) return;
    const y = yValue(value);
    ctx.beginPath();
    ctx.arc(cx, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors[key];
    ctx.stroke();
  });
}

function showCashflowTooltip(entry, clientX, clientY) {
  let tooltipHtml = "";
  if (entry.isInitial) {
    tooltipHtml = `
      <div class="tt-quarter">Q0 · 初始出资</div>
      <div class="tt-row tt-delta">劣后出资<span class="tt-value">−${currency.format(Math.abs(entry.equity))}</span></div>
      <div class="tt-row">AMC 配资<span class="tt-value">−${currency.format(Math.abs(entry.amc))}</span></div>
      <div class="tt-row">Mezz 配资<span class="tt-value">−${currency.format(Math.abs(entry.mezz))}</span></div>
    `;
  } else {
    const row = entry.row;
    tooltipHtml = `
      <div class="tt-quarter">第 ${row.quarter} 季 · 第 ${row.year} 年</div>
      <div class="tt-row"><span class="tt-dot tt-amc"></span>AMC 当季流入<span class="tt-value ${entry.amc >= 0 ? "" : "tt-negative"}">${entry.amc >= 0 ? "+" : "−"}${currency.format(Math.abs(entry.amc))}</span></div>
      <div class="tt-row"><span class="tt-dot tt-mezz"></span>Mezz 当季流入<span class="tt-value ${entry.mezz >= 0 ? "" : "tt-negative"}">${entry.mezz >= 0 ? "+" : "−"}${currency.format(Math.abs(entry.mezz))}</span></div>
      <div class="tt-row"><span class="tt-dot tt-equity"></span>劣后 当季净分录<span class="tt-value ${entry.equity >= 0 ? "tt-positive" : "tt-negative"}">${entry.equity >= 0 ? "+" : "−"}${currency.format(Math.abs(entry.equity))}</span></div>
      <div class="tt-divider"></div>
      <div class="tt-row">当季回收<span class="tt-value">${currency.format(row.grossRecovery)}</span></div>
      <div class="tt-row">扣减后净额<span class="tt-value">${currency.format(row.distributable)}</span></div>
      <div class="tt-row">AMC 利息 / 本金<span class="tt-value">${currency.format(row.amcInterestPaid)} / ${currency.format(row.amcPrincipalPaid)}</span></div>
      <div class="tt-row">Mezz 利息 / 本金<span class="tt-value">${currency.format(row.mezzInterestDue)} / ${currency.format(row.mezzPrincipalPaid)}</span></div>
      <div class="tt-row">当季返点<span class="tt-value">${currency.format(row.rebate)}</span></div>
    `;
  }
  tooltipEl.innerHTML = tooltipHtml;
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
  const pad = { left: 84, right: 18 };
  if (localX < pad.left || localX > rect.width - pad.right) {
    if (currentHoverIndex !== -1) {
      currentHoverIndex = -1;
      drawCashflowChart(cachedResult);
      hideChartTooltip();
    }
    return;
  }
  const innerWidth = rect.width - pad.left - pad.right;
  const totalGroups = cachedResult.rows.length + 1; // 21 groups (Q0..Q20)
  const idx = Math.round(((localX - pad.left) / innerWidth) * (totalGroups - 1));
  const clamped = Math.max(0, Math.min(totalGroups - 1, idx));
  if (clamped !== currentHoverIndex) {
    currentHoverIndex = clamped;
    drawCashflowChart(cachedResult);
  }
  const series = buildCashflowSeries(cachedResult);
  showCashflowTooltip(series[currentHoverIndex], event.clientX, event.clientY);
}

function handleChartLeave() {
  if (currentHoverIndex !== -1) {
    currentHoverIndex = -1;
    if (cachedResult) drawCashflowChart(cachedResult);
  }
  hideChartTooltip();
}

chart.addEventListener("mousemove", handleChartHover);
chart.addEventListener("mouseleave", handleChartLeave);

// ============ 投委口径 ============

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
      )}），劣后出资 ${currency.format(result.funds.equity)}，AMC 配资 ${currency.format(
        result.funds.amc,
      )}，Mezz 配资 ${currency.format(result.funds.mezz)}。`,
      tone: "good",
    },
    {
      title: `AMC 一次性通道费：${currency.format(channelFee)}`,
      body: `= 固定 ${currency.format(values.amcChannelFixed)} + 对价 × ${priceRate(
        values.amcChannelRate,
      )}，购包首期一次性从劣后支出，计入 AMC 收益（已并入 Q1 瀑布柱）。`,
      tone: channelFee > 0 ? "warn" : "good",
    },
    {
      title: `AMC 5年总收益：${currency.format(result.amcTotalRevenue)}`,
      body: `通道费 ${currency.format(channelFee)} + 累计利息 ${currency.format(
        result.totalAmcInterestPaid,
      )} + 累计管理费 ${currency.format(mgmtFee)}；年化 ROI ${percent(result.amcRoi)}。`,
      tone: "good",
    },
    {
      title: `Mezz 5年总兑付：${currency.format(result.totalMezzInterestPaid + result.totalMezzPrincipalPaid)}`,
      body: `= 利息 ${currency.format(result.totalMezzInterestPaid)}（季付 ${currency.format(
        result.funds.mezz > 0
          ? result.funds.mezz * (values.mezzRate / 100 / QUARTERS_PER_YEAR)
          : 0,
      )}）× 20 季 + 本金偿还 ${currency.format(result.totalMezzPrincipalPaid)}。`,
      tone: "good",
    },
    {
      title: `劣后 5年累计承担 Mezz 利息：${currency.format(result.totalMezzInterestPaid)}`,
      body: `每季刚性兑付，与当季可分配额无关；这是劣后 IRR 低于"利随本清"模型的主因。`,
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
      title: `折扣折损：${currency.format(result.totalWritedown)}`,
      body: `因 ${priceRate(values.discountRecoveryRate)} 折扣, 5 年累计额外抹销本金 ${currency.format(
        result.totalWritedown,
      )}（实际回款不变, 仅影响后续季度潜在回收能力）。`,
      tone: result.totalWritedown > 0 ? "warn" : "good",
    },
    {
      title: `回收安全倍率：${Number.isFinite(breakEven) ? multiple(1 / breakEven) : "-"}`,
      body:
        Number.isFinite(breakEven) && breakEven <= 1
          ? "当前 5 年回收假设高于劣后盈亏平衡水平。"
          : "当前 5 年回收假设不足以覆盖劣后盈亏，需要压低价格或提高处置效率。",
      tone: Number.isFinite(breakEven) && breakEven <= 1 ? "good" : "bad",
    },
    {
      title: `返点贡献：${currency.format(result.totalRebate)}`,
      body: `返点按当季回收额计提，约占劣后净分配的 ${
        result.totalResidual > 0 ? percent((result.totalRebate / result.totalResidual) * 100) : "-"
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

// ============ 季度明细表（分配瀑布列） ============

function renderTable(result) {
  const rows = result.rows;
  const equityInitial = -result.funds.equity;
  const amcInitial = -result.funds.amc;
  const mezzInitial = -result.funds.mezz;
  const equityChannelFee = -result.totalChannelFee;
  // Q0 行：三方配资 + 劣后付通道费，资产本金 100%，无回收
  // 累计列以 -配资 起算（=T0 净收益），Q1..Q20 累加后 Q20 = 卡片"累计净收益"
  const q0Row = `
    <tr class="row-t0">
      <td>Q0 · 购包</td>
      <td>${currency.format(result.faceValue || 0)}</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>${currency.format(equityInitial + equityChannelFee)}</td>
      <td>—</td>
      <td>${currency.format(amcInitial)}</td>
      <td>${currency.format(mezzInitial)}</td>
      <td>${currency.format(equityInitial + equityChannelFee)}</td>
    </tr>
  `;
  const periodRows = rows
    .map(
      (row) => `
        <tr>
          <td>第 ${row.quarter} 季</td>
          <td>${currency.format(row.beginningAssetPrincipal)}</td>
          <td>${currency.format(row.grossRecovery)}</td>
          <td>${currency.format(row.distributable)}</td>
          <td>${currency.format(row.amcInterestPaid)}</td>
          <td>${currency.format(row.amcPrincipalPaid)}</td>
          <td>${currency.format(row.mezzInterestDue)}</td>
          <td>${currency.format(row.mezzPrincipalPaid)}</td>
          <td class="${row.equityCash >= 0 ? "positive" : "negative"}">${row.equityCash >= 0 ? "+" : "−"}${currency.format(
            Math.abs(row.equityCash),
          )}</td>
          <td>${currency.format(row.rebate)}</td>
          <td>${currency.format(row.amcCumulativeRevenue)}</td>
          <td>${currency.format(row.mezzCumulativeRevenue)}</td>
          <td class="${row.cumulativeEquityAsset >= 0 ? "positive" : "negative"}">${currency.format(row.cumulativeEquityAsset)}</td>
        </tr>
      `,
    )
    .join("");
  document.querySelector("#projectionRows").innerHTML = q0Row + periodRows;
}

// ============ 敏感性热力 ============

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
      const irrLabel = Number.isFinite(scenario.irr) ? percent(scenario.irr, 0) : "无解";
      const moicLabel = Number.isFinite(scenario.moic) ? `${scenario.moic.toFixed(2)}x` : "-";
      cells.push(
        `<div class="cell ${verdict.className}" title="IRR ${irrLabel} · MOIC ${moicLabel} · 劣后净收益 ${currency.format(
          scenario.equityProfit,
        )}">
          <div class="cell-irr">${irrLabel}</div>
          <div class="cell-moic">${moicLabel}</div>
        </div>`,
      );
    });
  });

  document.querySelector("#sensitivityGrid").innerHTML = cells.join("");
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
  if (currentHoverIndex >= result.rows.length + 1) currentHoverIndex = -1;
  renderMetrics(result, values);
  renderFlowOverview(result, values);
  renderInsights(result, values);
  renderTable(result);
  renderSensitivity(values);
  // 用 requestAnimationFrame 确保布局完成再绘 canvas
  requestAnimationFrame(() => drawCashflowChart(result));
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
  if (name === null) return;
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
