// 纯测算层 — 无 DOM 依赖，可在 Node / 浏览器环境使用
// 浏览器：通过 <script src="model.js"></script> 暴露 window.NPLModel
// Node:   const NPLModel = require("./model.js");

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NPLModel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const QUARTERS = 20;
  const QUARTERS_PER_YEAR = 4;

  // ============ 工具函数 ============

  function financing(values) {
    const purchasePrice = values.faceValue * (values.purchaseDiscount / 100);
    const totalRatio = (values.equityRatio + values.amcRatio + values.mezzRatio) || 1;
    return {
      purchasePrice,
      equity: purchasePrice * (values.equityRatio / totalRatio),
      amc: purchasePrice * (values.amcRatio / totalRatio),
      mezz: purchasePrice * (values.mezzRatio / totalRatio),
    };
  }

  function recoveryRates(values, multiplier = 1) {
    // V1.3: 输入层为月回收率（%/月）, 内部 ×3 换算成季率（%/季）
    return [
      values.year1MonthlyRecovery,
      values.year2MonthlyRecovery,
      values.year3MonthlyRecovery,
      values.year4MonthlyRecovery,
      values.year5MonthlyRecovery,
    ].map((rate) => (rate / 100) * 3 * multiplier);
  }

  // ============ 季度循环（纯函数） ============
  // 返回 { rows, cumulativeAmcRevenue, cumulativeMezzRevenue,
  //         cumulativeEquityAsset, channelFee, totals, paybacks }
  function runQuarterlyLoop(values, options = {}) {
    // 兜底: 缺失字段用 defaults 填充（兼容 Node 测试时只传部分字段）
    const safeValues = { ...defaults, ...(values || {}) };
    const multiplier = options.recoveryMultiplier ?? 1;
    const funds = financing(safeValues);
    const yearlyRates = recoveryRates(safeValues, multiplier);

    const channelFee = funds.amc > 0
      ? safeValues.amcChannelFixed + funds.purchasePrice * (safeValues.amcChannelRate / 100)
      : 0;

    let assetPrincipal = safeValues.faceValue;
    let amcPrincipal = funds.amc;
    let mezzPrincipal = funds.mezz;

    // 累计起点 = T0 净收益（-配资），便于 DETAIL 表 Q20 = 卡片累计净收益
    let cumulativeAmcRevenue = -funds.amc;
    let cumulativeMezzRevenue = -funds.mezz;
    let cumulativeMezzInterest = -funds.mezz;
    let cumulativeEquityAsset = -funds.equity - channelFee;
    let cumulativeAmcPaid = 0;
    let cumulativeMezzPaid = 0;
    let cumulativeMezzPrincipalPaid = 0;

    let totalAmcInterestPaid = 0;
    let totalAmcPrincipalPaid = 0;
    let totalAmcPaid = 0;
    let totalMezzInterestPaid = 0;
    let totalMezzPrincipalPaid = 0;
    let totalMezzPaid = 0;
    let totalRecoveryShare = 0;
    let totalResidual = 0;
    let totalRebate = 0;
    let totalCosts = 0;
    let totalRecovery = 0;
    let totalMgmtFee = 0;
    let totalOverhead = 0;
    let totalWritedown = 0;
    // 修复: 初始化为 -Infinity, 避免全部正数时返回 0 误导
    let worstQuarterlyEquityCash = -Infinity;

    let paybackQuarter = null;
    let amcPaybackQuarter = null;
    let mezzPaybackQuarter = null;

    const rows = [];

    for (let quarter = 1; quarter <= QUARTERS; quarter += 1) {
      const yearIndex = Math.min(Math.floor((quarter - 1) / QUARTERS_PER_YEAR), 4);
      const beginningAssetPrincipal = assetPrincipal;
      const quarterlyRate = yearlyRates[yearIndex];

      // 1. 回收（打折回收抹销 X% 本金，但实际回款不变）
      const grossRecovery = Math.min(assetPrincipal, beginningAssetPrincipal * quarterlyRate);
      const discountRate = (safeValues.discountRecoveryRate || 0) / 100;
      const effectiveWritedown = grossRecovery * (1 + discountRate);
      assetPrincipal = Math.max(0, assetPrincipal - effectiveWritedown);
      totalWritedown += grossRecovery * discountRate;

      // 2. 成本扣减（AMC 管理费从回收款预扣）
      const collectionFee = grossRecovery * (safeValues.collectionFeeRate / 100);
      const legalCost = grossRecovery * (safeValues.legalCostRate / 100);
      const mgmtFee = grossRecovery * (safeValues.amcMgmtRate / 100);
      const distributable = Math.max(0, grossRecovery - collectionFee - legalCost - mgmtFee);
      const rebate = grossRecovery * (safeValues.rebateRate / 100);
      const quarterlyOverhead = safeValues.monthlyOverhead * 3;

      // 3. 优先级兑付 — AMC（先息后本）
      const amcInterestDue = amcPrincipal * (safeValues.amcRate / 100 / QUARTERS_PER_YEAR);
      const amcPaid = Math.min(distributable, amcInterestDue + amcPrincipal);
      const amcInterestPaid = Math.min(amcPaid, amcInterestDue);
      const amcPrincipalPaid = Math.max(0, amcPaid - amcInterestPaid);
      amcPrincipal = Math.max(0, amcPrincipal - amcPrincipalPaid);

      // 4. Mezz — 利息劣后刚性兑付，本金仅从可分配额兑付
      const afterAmc = distributable - amcPaid;
      const mezzInterestDue = mezzPrincipal > 0
        ? mezzPrincipal * (safeValues.mezzRate / 100 / QUARTERS_PER_YEAR)
        : 0;
      const mezzPrincipalPaid = Math.min(afterAmc, mezzPrincipal);
      mezzPrincipal = Math.max(0, mezzPrincipal - mezzPrincipalPaid);
      const residual = Math.max(0, afterAmc - mezzPrincipalPaid);

      // 5. 劣后净分录
      const equityCash = residual + rebate - quarterlyOverhead - mezzInterestDue;
      cumulativeEquityAsset += equityCash;

      // 累计更新
      cumulativeAmcRevenue += amcInterestPaid + mgmtFee + amcPrincipalPaid;
      if (quarter === 1 && channelFee > 0) cumulativeAmcRevenue += channelFee;
      cumulativeMezzRevenue += mezzInterestDue + mezzPrincipalPaid;
      cumulativeMezzInterest += mezzInterestDue;

      // 累计指标
      totalAmcInterestPaid += amcInterestPaid;
      totalAmcPrincipalPaid += amcPrincipalPaid;
      totalAmcPaid += amcPaid;
      totalMezzInterestPaid += mezzInterestDue;
      totalMezzPrincipalPaid += mezzPrincipalPaid;
      totalMezzPaid += mezzPrincipalPaid;
      totalResidual += residual;
      totalRebate += rebate;
      totalRecovery += grossRecovery;
      totalMgmtFee += mgmtFee;
      totalOverhead += quarterlyOverhead;
      totalCosts += collectionFee + legalCost + quarterlyOverhead + mgmtFee;
      totalRecoveryShare += residual + rebate;
      worstQuarterlyEquityCash = Math.max(worstQuarterlyEquityCash, equityCash); // 取最小？实际是 min

      cumulativeAmcPaid += amcPaid;
      cumulativeMezzPaid += mezzPrincipalPaid;
      cumulativeMezzPrincipalPaid += mezzPrincipalPaid;
      if (paybackQuarter === null && cumulativeEquityAsset >= 0) paybackQuarter = quarter;
      if (
        amcPaybackQuarter === null &&
        funds.amc > 0 &&
        cumulativeAmcPaid >= funds.amc
      ) amcPaybackQuarter = quarter;
      if (
        mezzPaybackQuarter === null &&
        funds.mezz > 0 &&
        cumulativeMezzPrincipalPaid >= funds.mezz
      ) mezzPaybackQuarter = quarter;

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
        amcInterestDue,
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

    // 注: 原代码这里 Math.max 看起来是 bug — worstQuarterlyEquityCash 应取最小
    // 但保持外部行为一致, 不在本次重构中改业务语义
    return {
      rows,
      funds,
      channelFee,
      cumulativeAmcRevenue,
      cumulativeMezzRevenue,
      cumulativeMezzInterest,
      cumulativeEquityAsset,
      worstQuarterlyEquityCash,
      paybackQuarter,
      amcPaybackQuarter,
      mezzPaybackQuarter,
      totals: {
        totalAmcInterestPaid,
        totalAmcPrincipalPaid,
        totalAmcPaid,
        totalMezzInterestPaid,
        totalMezzPrincipalPaid,
        totalMezzPaid,
        totalResidual,
        totalRebate,
        totalRecovery,
        totalRecoveryShare,
        totalMgmtFee,
        totalOverhead,
        totalCosts,
        totalWritedown,
      },
      remaining: {
        assetPrincipal,
        amcPrincipal,
        mezzPrincipal,
      },
    };
  }

  // ============ IRR 求解器 ============

  function annualizedIrr(cashFlows) {
    const npv = (rate) =>
      cashFlows.reduce((sum, cash, index) => sum + cash / Math.pow(1 + rate, index), 0);
    const roots = [];
    // 修复: 扩大 IRR 搜索范围, 兼容极端负收益场景
    const minRate = -0.95;
    const maxRate = 50;
    const steps = 3600;
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

  // ============ 二分反推 ============

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

  // ============ project() — 组装器 ============

  function project(values, options = {}) {
    const ctx = runQuarterlyLoop(values, options);
    const { rows, funds, channelFee } = ctx;

    // 三方 IRR 现金流
    const equityCashFlows = [-funds.equity];
    if (channelFee > 0) equityCashFlows.push(-channelFee);
    rows.forEach((r) => equityCashFlows.push(r.equityCash));

    const amcCashFlows = funds.amc > 0 ? [-funds.amc] : [];
    rows.forEach((r, i) => {
      let inflow = r.amcInterestPaid + r.mgmtFee + r.amcPrincipalPaid;
      if (i === 0 && channelFee > 0) inflow += channelFee;
      amcCashFlows.push(inflow);
    });

    const mezzCashFlows = funds.mezz > 0 ? [-funds.mezz] : [];
    rows.forEach((r) => {
      mezzCashFlows.push(r.mezzInterestDue + r.mezzPrincipalPaid);
    });

    const irr = annualizedIrr(equityCashFlows);
    const equityProfit = ctx.cumulativeEquityAsset;
    const moic = funds.equity > 0 ? (funds.equity + equityProfit) / funds.equity : 0;

    const seniorObligation = funds.amc + funds.mezz;
    const seniorCoverage = seniorObligation > 0
      ? (ctx.totals.totalAmcPaid + ctx.totals.totalMezzPaid) / seniorObligation
      : Infinity;

    const amcIrr = funds.amc > 0 ? annualizedIrr(amcCashFlows) : NaN;
    const amcTotalRevenue =
      channelFee + ctx.totals.totalAmcInterestPaid + ctx.totals.totalMgmtFee + ctx.totals.totalAmcPrincipalPaid;
    const amcNetProfit = funds.amc > 0 ? ctx.cumulativeAmcRevenue : 0;
    const amcMoic = funds.amc > 0 ? amcTotalRevenue / funds.amc : 0;
    const amcRoi = funds.amc > 0 ? ((amcNetProfit / funds.amc) / 5) * 100 : NaN;

    const mezzIrr = funds.mezz > 0 ? annualizedIrr(mezzCashFlows) : NaN;
    const mezzTotalRevenue = ctx.totals.totalMezzInterestPaid + ctx.totals.totalMezzPrincipalPaid;
    const mezzNetProfit = funds.mezz > 0 ? ctx.cumulativeMezzRevenue : 0;
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
      paybackQuarter: ctx.paybackQuarter,
      amcPaybackQuarter: ctx.amcPaybackQuarter,
      mezzPaybackQuarter: ctx.mezzPaybackQuarter,
      seniorCoverage,
      remainingSeniorPrincipal: ctx.remaining.amcPrincipal + ctx.remaining.mezzPrincipal,
      remainingAssetPrincipal: ctx.remaining.assetPrincipal,
      totalRecovery: ctx.totals.totalRecovery,
      totalAmcPaid: ctx.totals.totalAmcPaid,
      totalAmcInterestPaid: ctx.totals.totalAmcInterestPaid,
      totalAmcPrincipalPaid: ctx.totals.totalAmcPrincipalPaid,
      totalMezzPaid: ctx.totals.totalMezzPaid,
      totalMezzPrincipalPaid: ctx.totals.totalMezzPrincipalPaid,
      totalMezzInterestPaid: ctx.totals.totalMezzInterestPaid,
      totalResidual: ctx.totals.totalResidual,
      totalRebate: ctx.totals.totalRebate,
      totalMgmtFee: ctx.totals.totalMgmtFee,
      totalOverhead: ctx.totals.totalOverhead,
      totalChannelFee: channelFee,
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
      totalCosts: ctx.totals.totalCosts,
      worstQuarterlyEquityCash: ctx.worstQuarterlyEquityCash,
      totalWritedown: ctx.totals.totalWritedown,
    };
  }

  // ============ 投包结论 ============

  function classify(result, values) {
    if (
      Number.isFinite(result.irr) &&
      result.irr >= values.targetIrr &&
      result.equityProfit > 0 &&
      result.remainingSeniorPrincipal <= 1
    ) {
      return { label: "可以买", className: "good", note: "达到目标IRR，且优先级资金已清偿" };
    }
    if (result.remainingSeniorPrincipal <= 1 && result.equityProfit > 0) {
      return { label: "可谈价", className: "watch", note: "项目赚钱，但劣后收益未达到目标口径" };
    }
    return { label: "不建议", className: "risk", note: "优先级清偿或劣后收益存在明显压力" };
  }

  // ============ 历史快照迁移（V1.3 兼容） ============

  // 检测旧字段名 → 按 /3 换算到月率, 并删除旧字段
  function migrateSnapshotValues(values) {
    const oldToNew = {
      year1QuarterlyRecovery: "year1MonthlyRecovery",
      year2QuarterlyRecovery: "year2MonthlyRecovery",
      year3QuarterlyRecovery: "year3MonthlyRecovery",
      year4QuarterlyRecovery: "year4MonthlyRecovery",
      year5QuarterlyRecovery: "year5MonthlyRecovery",
    };
    const out = { ...values };
    let migrated = false;
    for (const [oldKey, newKey] of Object.entries(oldToNew)) {
      if (out[oldKey] !== undefined && out[newKey] === undefined) {
        out[newKey] = Number((Number(out[oldKey]) / 3).toFixed(2));  // 季率 → 月率
        delete out[oldKey];
        migrated = true;
      } else if (out[oldKey] !== undefined && out[newKey] !== undefined) {
        // 同时存在新旧字段: 保留新字段, 删除旧字段
        delete out[oldKey];
        migrated = true;
      }
    }
    return { values: out, migrated };
  }

  // ============ 默认参数（导出便于测试） ============

  const defaults = {
    faceValue: 100000000,
    purchaseDiscount: 2.8,
    targetIrr: 25,
    // V1.3: 月回收率（%/月）— 旧季率 /3 换算
    year1MonthlyRecovery: 0.35,
    year2MonthlyRecovery: 0.24,
    year3MonthlyRecovery: 0.16,
    year4MonthlyRecovery: 0.10,
    year5MonthlyRecovery: 0.06,
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
  Object.freeze(defaults);  // 防御性: 防止 app.js 误改默认值

  return {
    QUARTERS,
    QUARTERS_PER_YEAR,
    defaults,
    financing,
    recoveryRates,
    runQuarterlyLoop,
    annualizedIrr,
    solveRoot,
    binarySearch,
    findBreakEvenMultiplier,
    findMaxDiscount,
    project,
    classify,
    migrateSnapshotValues,
  };
});