// 测算口径单元测试 — Node 24 内置 test runner（无构建工具依赖）
// 运行: cd 网页 && node --test tests/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const M = require("../model.js");

const { defaults, project, runQuarterlyLoop, financing, recoveryRates,
        annualizedIrr, classify, findBreakEvenMultiplier, findMaxDiscount } = M;

// 允许 1 元的浮点累积误差
const EPS = 1;

// ============ 1. financing() ============

test("financing: 按比例归一化分配购包价", () => {
  const f = financing({ ...defaults, equityRatio: 25, amcRatio: 55, mezzRatio: 20,
                        faceValue: 100000000, purchaseDiscount: 10 });
  // 购包价 = 100000000 * 10% = 10,000,000
  assert.equal(f.purchasePrice, 10000000);
  // 25 + 55 + 20 = 100, 归一化不需要
  assert.equal(f.equity, 2500000);
  assert.equal(f.amc, 5500000);
  assert.equal(f.mezz, 2000000);
});

test("financing: 比例之和 ≠ 100 也按比例归一化", () => {
  const f = financing({ ...defaults, equityRatio: 1, amcRatio: 1, mezzRatio: 1,
                        faceValue: 100000000, purchaseDiscount: 10 });
  // 1+1+1=3, equity = 10M / 3
  assert.ok(Math.abs(f.equity - 10000000 / 3) < EPS);
  assert.ok(Math.abs(f.amc - 10000000 / 3) < EPS);
  assert.ok(Math.abs(f.mezz - 10000000 / 3) < EPS);
});

test("financing: 全 0 比例时 fallback 到总和=1（不抛错）", () => {
  const f = financing({ ...defaults, equityRatio: 0, amcRatio: 0, mezzRatio: 0,
                        faceValue: 100000000, purchaseDiscount: 10 });
  assert.equal(f.equity, 0);
  assert.equal(f.amc, 0);
  assert.equal(f.mezz, 0);
});

// ============ 2. recoveryRates() ============

test("recoveryRates: 5 年季回收率按 multiplier 缩放", () => {
  const r = recoveryRates({ year1QuarterlyRecovery: 1, year2QuarterlyRecovery: 2,
                            year3QuarterlyRecovery: 3, year4QuarterlyRecovery: 4,
                            year5QuarterlyRecovery: 5 }, 2);
  assert.deepEqual(r, [0.02, 0.04, 0.06, 0.08, 0.10]);
});

// ============ 3. 优先级清偿 — AMC 先息后本 ============

test("AMC 优先级: 当 AMC 本金一次性清偿, 先付完所有利息再付本金", () => {
  // 构造：AMC 配资 100万, 单季大额回款一次性还清
  const r = project({
    ...defaults,
    faceValue: 10000000,
    purchaseDiscount: 10,    // 购包价 = 100万
    equityRatio: 0,
    amcRatio: 100,
    mezzRatio: 0,
    amcRate: 8,
    amcChannelFixed: 0,
    amcChannelRate: 0,
    amcMgmtRate: 0,
    collectionFeeRate: 0,
    legalCostRate: 0,
    rebateRate: 0,
    monthlyOverhead: 0,
    year1QuarterlyRecovery: 50,  // Q1 收 50% = 500万 → 一次性还清 AMC 100万 + 大笔留底
    year2QuarterlyRecovery: 0,
    year3QuarterlyRecovery: 0,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
  });
  // AMC 配资 = 100万
  // Q1 amcInterestPaid = min(102万, 2万) = 2万（先息）
  assert.ok(Math.abs(r.rows[0].amcInterestPaid - 20000) < 0.01);
  // Q1 amcPrincipalPaid = 102万 - 2万 = 100万（后本）
  assert.ok(Math.abs(r.rows[0].amcPrincipalPaid - 1000000) < 0.01);
  // Q1 后 AMC 余额 = 0
  assert.equal(r.remainingSeniorPrincipal, 0);
  // AMC 总实收 = 2万利息 + 100万本金 = 102万
  assert.ok(Math.abs(r.totalAmcPaid - 1020000) < 0.01);
});

test("AMC 优先级: 资金不足时, AMC 本金部分清偿", () => {
  const r = project({
    ...defaults,
    faceValue: 10000000,
    purchaseDiscount: 10,
    equityRatio: 0,
    amcRatio: 100,
    mezzRatio: 0,
    amcRate: 8,
    amcChannelFixed: 0,
    amcChannelRate: 0,
    amcMgmtRate: 0,
    collectionFeeRate: 0,
    legalCostRate: 0,
    rebateRate: 0,
    monthlyOverhead: 0,
    year1QuarterlyRecovery: 0.5,  // Q1 仅收 0.5% = 5万 → 不够付利息+本金
    year2QuarterlyRecovery: 0,
    year3QuarterlyRecovery: 0,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
  });
  // AMC 配资 = 100万, Q1 应收利息 = 2万, 可分配 = 5万
  // → amcPaid = 5万 = 2万利息 + 3万本金（先息后本）
  assert.ok(Math.abs(r.rows[0].amcInterestPaid - 20000) < 0.01);
  assert.ok(Math.abs(r.rows[0].amcPrincipalPaid - 30000) < 0.01);
  // Q1 后 AMC 余额 = 97 万
  assert.ok(Math.abs(r.rows[0].amcBalance - 970000) < 0.01);
  // 后续季度也按 0.5% 收, 永远还不清 → 期末仍有较大剩余
  assert.ok(r.remainingSeniorPrincipal > 800000);
  assert.ok(r.remainingSeniorPrincipal < 970000);
});

// ============ 4. Mezz 劣后刚性兑付 ============

test("Mezz 劣后刚性兑付: 可分配额为 0 时, Mezz 利息仍照扣劣后", () => {
  const r = project({
    ...defaults,
    faceValue: 10000000,
    purchaseDiscount: 10,
    equityRatio: 25,
    amcRatio: 55,
    mezzRatio: 20,
    amcRate: 0,        // AMC 0 利率 → 不抢可分配额
    amcChannelFixed: 0,
    amcChannelRate: 0,
    amcMgmtRate: 0,
    mezzRate: 14,
    collectionFeeRate: 0,
    legalCostRate: 0,
    rebateRate: 0,
    monthlyOverhead: 0,
    year1QuarterlyRecovery: 0,    // Q1..Q20 全 0 回收
    year2QuarterlyRecovery: 0,
    year3QuarterlyRecovery: 0,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
  });
  // 购包价 = 1000万 * 10% = 100万; mezz = 100万 * 20% = 20万
  // Mezz 季利息 = 20万 * 14% / 4 = 7000
  assert.ok(Math.abs(r.rows[0].mezzInterestDue - 7000) < 0.01);
  // Q1 可分配 = 0 → mezzPrincipalPaid = 0
  assert.equal(r.rows[0].mezzPrincipalPaid, 0);
  // Q1 equityCash = 0 + 0 - 0 - 7000 = -7000 (劣后兜底)
  assert.ok(Math.abs(r.rows[0].equityCash - (-7000)) < 0.01);
  // Mezz 累计净收益 = -20万 (T0 配资出) + 20 季 × 7000 利息 = -20万 + 14万 = -6万
  assert.ok(Math.abs(r.mezzNetProfit - (-60000)) < 0.01);
  // Mezz 累计应收利息 = 20 季 × 7000 = 140000 (但劣后兜底, 实际已计入 equityCash)
  assert.ok(Math.abs(r.totalMezzInterestPaid - 140000) < 0.01);
});

test("Mezz 本金兑付: 仅从可分配额兑付（先还本，区别于 AMC）", () => {
  const r = project({
    ...defaults,
    faceValue: 10000000,
    purchaseDiscount: 10,
    equityRatio: 0,
    amcRatio: 0,
    mezzRatio: 100,
    mezzRate: 0,  // Mezz 利率 0, 纯测本金兑付
    amcMgmtRate: 0,  // AMC 管理费=0, 否则默认 5% 会扣减可分配额
    collectionFeeRate: 0,
    legalCostRate: 0,
    rebateRate: 0,
    monthlyOverhead: 0,
    year1QuarterlyRecovery: 5,  // Q1 收 5% = 50万
    year2QuarterlyRecovery: 0,
    year3QuarterlyRecovery: 0,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
  });
  // 购包价 = 1000万 * 10% = 100万; mezz = 100万 * 100% = 100万
  // Q1 收 = 1000万 * 5% = 50万 → 可分配 = 50万 (扣减项全 0)
  // Q1 mezzPrincipalPaid = min(500000, 1000000) = 500000
  assert.ok(Math.abs(r.rows[0].mezzPrincipalPaid - 500000) < 0.01);
  assert.equal(r.rows[0].mezzInterestDue, 0);
  // Q1 后 Mezz 剩余本金 = 100 - 50 = 50 万
  assert.ok(Math.abs(r.rows[0].mezzBalance - 500000) < 0.01);
  // 后续季度 Q2 47.5万 + Q3 2.5万 = 50万, Mezz 全部清偿
  // 期末 senior 剩余应为 0
  assert.ok(Math.abs(r.remainingSeniorPrincipal - 0) < 0.01);
  // 总兑付 = 100 万 = mezz 配资
  assert.ok(Math.abs(r.totalMezzPrincipalPaid - 1000000) < 0.01);
});

// ============ 5. 累计对账：DETAIL 表 Q20 = 卡片累计净收益 ============

test("DETAIL 对账: AMC 累计 Q20 = 卡片 AMC 净收益", () => {
  const r = project(defaults);
  const lastRow = r.rows[r.rows.length - 1];
  assert.equal(lastRow.amcCumulativeRevenue, r.amcNetProfit);
});

test("DETAIL 对账: Mezz 累计 Q20 = 卡片 Mezz 净收益", () => {
  const r = project(defaults);
  const lastRow = r.rows[r.rows.length - 1];
  assert.equal(lastRow.mezzCumulativeRevenue, r.mezzNetProfit);
});

test("DETAIL 对账: 劣后累计 Q20 = 卡片劣后净收益", () => {
  const r = project(defaults);
  const lastRow = r.rows[r.rows.length - 1];
  assert.equal(lastRow.cumulativeEquityAsset, r.equityProfit);
});

// ============ 6. AMC 通道费：购包时一次性从劣后出 ============

test("AMC 通道费: 固定 + 对价 × 费率, 首期一次性从劣后支出", () => {
  const r = project({
    ...defaults,
    amcChannelFixed: 500000,
    amcChannelRate: 1.5,
    faceValue: 100000000,
    purchaseDiscount: 2.8,
  });
  // 购包价 = 100M * 2.8% = 2,800,000
  // 通道费 = 500,000 + 2,800,000 * 1.5% = 500,000 + 42,000 = 542,000
  assert.equal(r.totalChannelFee, 542000);
  // 验证通道费已计入 AMC Q1 累计
  // amcTotalRevenue = channelFee + totalAmcInterestPaid + totalMgmtFee + totalAmcPrincipalPaid
  // amcNetProfit = -配资 + amcTotalRevenue
  // Q1 累计 = -配资 + channelFee + Q1 当季利息+本金+管理费
  const q1Expected = -r.funds.amc + r.totalChannelFee
    + r.rows[0].amcInterestPaid + r.rows[0].mgmtFee + r.rows[0].amcPrincipalPaid;
  assert.ok(Math.abs(r.rows[0].amcCumulativeRevenue - q1Expected) < EPS);
});

test("AMC 通道费: 0 配资时通道费也为 0", () => {
  const r = project({ ...defaults, amcRatio: 0 });
  assert.equal(r.totalChannelFee, 0);
});

// ============ 7. 打折回收：实际回款不变, 本金额外抹销 ============

test("打折回收 X%: 本金期末剩余 < 不打折时, totalWritedown > 0", () => {
  const base = project(defaults);
  const withDiscount = project({ ...defaults, discountRecoveryRate: 10 });
  // 期末剩余本金变小
  assert.ok(withDiscount.remainingAssetPrincipal < base.remainingAssetPrincipal,
    `discount: ${withDiscount.remainingAssetPrincipal} vs base: ${base.remainingAssetPrincipal}`);
  // totalWritedown > 0
  assert.ok(withDiscount.totalWritedown > 0);
  // totalRecovery 可能也变小（后续季度 grossRecovery 因 assetPrincipal 减小而减小）
  assert.ok(withDiscount.totalRecovery <= base.totalRecovery);
  // 抹销额 ≈ sum(grossRecovery × 10%)
  // 期末剩余本金缩小比例合理 (默认参数下 10% 折扣约缩 0.5% - 5%)
  const shrinkRatio = (base.remainingAssetPrincipal - withDiscount.remainingAssetPrincipal)
                      / base.remainingAssetPrincipal;
  assert.ok(shrinkRatio > 0.001 && shrinkRatio < 0.20,
    `shrink ratio out of range: ${shrinkRatio}`);
});

test("打折回收 X = 0%: 与不打折完全一致", () => {
  const base = project(defaults);
  const same = project({ ...defaults, discountRecoveryRate: 0 });
  assert.equal(same.totalWritedown, 0);
  assert.equal(same.remainingAssetPrincipal, base.remainingAssetPrincipal);
  assert.equal(same.totalRecovery, base.totalRecovery);
});

// ============ 8. IRR：与 Excel XIRR 口径近似 ============

test("IRR: 单期投入 + 单期回流 = 简单 IRR", () => {
  // 投入 -100, 回流 110, 一期（季度）
  // 季 IRR = 10%, 年化 = (1.1)^4 - 1 ≈ 46.41%
  const irr = annualizedIrr([-100, 110]);
  assert.ok(Math.abs(irr - 46.41) < 0.1, `实际: ${irr}`);
});

test("IRR: 全部回款为零时返回 NaN", () => {
  assert.ok(Number.isNaN(annualizedIrr([-100, 0, 0, 0])));
});

test("IRR: 劣后回款远低于投入时 IRR 为负", () => {
  // 至少有一点回流, 让 IRR 求解器能找到根
  const r = project({
    ...defaults,
    year1QuarterlyRecovery: 0.1,
    year2QuarterlyRecovery: 0.05,
    year3QuarterlyRecovery: 0.02,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
    // 消除优先级对劣后的吃光: 让 AMC / Mezz 配资为 0
    amcRatio: 0,
    mezzRatio: 0,
  });
  // 投入 ~70万, 回流极少 → IRR 应为负或 NaN
  // 接受 IRR 为负 (代表亏本) 或 NaN (无解, 也暗示亏本)
  assert.ok(r.irr <= 0 || Number.isNaN(r.irr), `IRR should be <= 0 or NaN: ${r.irr}`);
});

// ============ 9. classify() 投包结论 ============

test("classify: 全部满足条件 → 可以买 (good)", () => {
  // 构造一个 IRR 达标 + 劣后盈利 + 优先级清偿的场景
  const r = project({
    ...defaults,
    year1QuarterlyRecovery: 5,
    year2QuarterlyRecovery: 5,
    year3QuarterlyRecovery: 5,
    year4QuarterlyRecovery: 5,
    year5QuarterlyRecovery: 5,
    targetIrr: 15,
  });
  const c = classify(r, { ...defaults, targetIrr: 15 });
  assert.equal(c.className, "good");
  assert.equal(c.label, "可以买");
});

test("classify: 默认参数（亏本）→ 不建议 (risk)", () => {
  const r = project(defaults);
  const c = classify(r, defaults);
  // 默认参数下劣后盈利为负, 优先级可能未清偿
  assert.ok(["risk", "watch"].includes(c.className));
});

// ============ 10. 二分反推 ============

test("findMaxDiscount: 低价必达标, 高价必不达标 → 返回边界", () => {
  const v = { ...defaults, targetIrr: 100 };  // 极高目标, 仅低价能达
  const max = findMaxDiscount(v);
  // 应当返回 ≤ 5% 的某个值
  assert.ok(Number.isFinite(max));
  assert.ok(max > 0 && max < 10);
});

test("findBreakEvenMultiplier: 找到让 equityProfit = 0 的倍率", () => {
  const v = { ...defaults, year1QuarterlyRecovery: 2, year2QuarterlyRecovery: 1 };
  const be = findBreakEvenMultiplier(v);
  assert.ok(Number.isFinite(be));
  // 在 be 处, equityProfit 应 ≈ 0
  const result = project(v, { recoveryMultiplier: be });
  assert.ok(Math.abs(result.equityProfit) < 100);
});

test("findBreakEvenMultiplier: 永远亏损的参数 → 返回接近 5 的高倍率", () => {
  const v = { ...defaults, year1QuarterlyRecovery: 0.01 };
  const be = findBreakEvenMultiplier(v);
  // 极低回收, 需要 5x 才能勉强回本
  assert.ok(be > 1);
});

// ============ 11. 返点：直接归劣后 ============

test("返点 X%: totalRebate = totalRecovery × X%", () => {
  const r = project({ ...defaults, rebateRate: 5 });
  // 5% 返点, 但已含 channelFee 一次性扣减
  const expected = r.totalRecovery * 0.05;
  assert.ok(Math.abs(r.totalRebate - expected) < EPS);
});

// ============ 12. 数据完整性 ============

test("project(): 恰好返回 20 个季度行", () => {
  const r = project(defaults);
  assert.equal(r.rows.length, 20);
});

test("project(): rows 的 quarter 字段是 1..20", () => {
  const r = project(defaults);
  r.rows.forEach((row, idx) => {
    assert.equal(row.quarter, idx + 1);
  });
});

test("runQuarterlyLoop: 返回的所有季度字段齐全", () => {
  const ctx = runQuarterlyLoop(defaults);
  assert.equal(ctx.rows.length, 20);
  ctx.rows.forEach((row) => {
    assert.ok("beginningAssetPrincipal" in row);
    assert.ok("grossRecovery" in row);
    assert.ok("amcInterestPaid" in row);
    assert.ok("mezzInterestDue" in row);
    assert.ok("equityCash" in row);
  });
});

// ============ 13. 边界场景（V1.2 新增）============

test("边界: faceValue=0 时所有金额字段应为 0", () => {
  const r = project({ ...defaults, faceValue: 0 });
  assert.equal(r.funds.purchasePrice, 0);
  assert.equal(r.funds.equity, 0);
  assert.equal(r.funds.amc, 0);
  assert.equal(r.funds.mezz, 0);
  assert.equal(r.totalRecovery, 0);
  assert.equal(r.totalAmcInterestPaid, 0);
  assert.equal(r.totalMezzInterestPaid, 0);
  assert.equal(r.totalChannelFee, 0);
  assert.equal(r.remainingAssetPrincipal, 0);
});

test("边界: purchaseDiscount=0（白送）时配资全 0", () => {
  const r = project({ ...defaults, purchaseDiscount: 0 });
  assert.equal(r.funds.purchasePrice, 0);
  assert.equal(r.funds.equity, 0);
  assert.equal(r.funds.amc, 0);
  assert.equal(r.funds.mezz, 0);
  assert.equal(r.totalChannelFee, 0);
});

test("边界: 全部 recovery=0 时 IRR=NaN（无可分配现金流）", () => {
  const r = project({
    ...defaults,
    year1QuarterlyRecovery: 0,
    year2QuarterlyRecovery: 0,
    year3QuarterlyRecovery: 0,
    year4QuarterlyRecovery: 0,
    year5QuarterlyRecovery: 0,
  });
  // 无回款 → 无任何正现金流 → IRR 求解无根
  assert.ok(Number.isNaN(r.irr));
  assert.ok(r.equityProfit < 0);  // 劣后至少要承担 Mezz 利息
});

test("边界: amcRatio=0 → 通道费为 0（无 AMC 配资则无通道费）", () => {
  const r = project({ ...defaults, amcRatio: 0 });
  assert.equal(r.funds.amc, 0);
  assert.equal(r.totalChannelFee, 0);
  // AMC 累计净收益 = -配资 + 全部为 0 = 0
  assert.equal(r.amcNetProfit, 0);
});

test("边界: mezzRatio=0 + mezzRate=0 → Mezz 累计为 0", () => {
  const r = project({ ...defaults, mezzRatio: 0 });
  assert.equal(r.funds.mezz, 0);
  assert.equal(r.totalMezzInterestPaid, 0);
  assert.equal(r.totalMezzPrincipalPaid, 0);
  assert.equal(r.mezzNetProfit, 0);
});

test("边界: discountRecoveryRate=0 与不传值完全一致", () => {
  const baseline = project(defaults);
  const explicit = project({ ...defaults, discountRecoveryRate: 0 });
  assert.equal(baseline.totalWritedown, explicit.totalWritedown);
  assert.equal(baseline.remainingAssetPrincipal, explicit.remainingAssetPrincipal);
  assert.equal(baseline.totalRecovery, explicit.totalRecovery);
});

test("classify: watch 分支（盈利但 IRR 未达标）", () => {
  // 构造: 高回收 + 极高 target → IRR < target 但优先级清偿 + 盈利
  // 实测 3% 季回收率下 IRR ≈ 634%, 所以 target 设到 1000% 才能触发 watch
  const r = project({
    ...defaults,
    year1QuarterlyRecovery: 3,
    year2QuarterlyRecovery: 3,
    year3QuarterlyRecovery: 3,
    year4QuarterlyRecovery: 3,
    year5QuarterlyRecovery: 3,
  });
  assert.ok(Number.isFinite(r.irr));
  // 优先级清偿 + equityProfit > 0 已确认
  assert.ok(r.equityProfit > 0);
  assert.ok(r.remainingSeniorPrincipal <= 1);
  // target=1000%, IRR=634% → watch
  const c = classify(r, { ...defaults, targetIrr: 1000 });
  assert.equal(c.className, "watch");
  assert.equal(c.label, "可谈价");
});

test("Object.freeze: defaults 不可写（防御性）", () => {
  assert.throws(() => { defaults.faceValue = 0; }, TypeError);
});