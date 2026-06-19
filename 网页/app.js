// 视图层 — DOM 绑定 + 渲染 + 历史快照持久化
// 测算逻辑在 model.js（纯函数，可在 Node 环境单测）
"use strict";

const {
  financing,
  project,
  classify,
  findBreakEvenMultiplier,
  defaults: MODEL_DEFAULTS,
} = window.NPLModel;

const defaults = MODEL_DEFAULTS;

const fields = Object.keys(defaults);

// 一次性缓存所有 DOM 引用（避免每次 render 重复 querySelector）
const $ = {};
[
  "modelForm", "resetButton", "cashflowChart", "chartTooltip",
  "verdictBanner", "verdict", "verdictNote",
  "amcInitialOut", "amcChannelFeeLine", "amcInterestLine", "amcMgmtLine",
  "amcPrincipalLine", "amcNetProfit", "amcIrr", "amcMoic", "amcRoi", "amcPayback",
  "mezzInitialOut", "mezzInterestLine", "mezzPrincipalLine", "mezzNetProfit",
  "mezzIrr", "mezzMoic", "mezzRoi", "mezzPayback",
  "equityInitialOut", "equityChannelFee", "equityRecoveryShare", "equityRebate",
  "equityOverhead", "equityMezzInterest", "equityNetProfit", "equityIrr",
  "equityMoic", "equityPayback",
  "flowDiagram", "insights", "projectionRows", "sensitivityGrid",
  "historyPanel", "saveHistoryButton", "toggleHistoryButton",
  "clearHistoryButton", "historyList", "historyCount",
].forEach((id) => { $[id] = document.getElementById(id); });

const form = $.modelForm;
const resetButton = $.resetButton;
const chart = $.cashflowChart;
const tooltipEl = $.chartTooltip;
const ctx = chart.getContext("2d");

let cachedResult = null;
let currentHoverIndex = -1;

const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
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
    form.querySelector(`#${field}`).value = defaults[field];
  });
  updateModel();
}

function getInputs() {
  return fields.reduce((values, field) => {
    values[field] = Number(form.querySelector(`#${field}`).value) || 0;
    return values;
  }, {});
}

// ============ 参与方卡渲染 ============

function renderMetrics(result, values) {
  const verdict = classify(result, values);
  $.verdictBanner.className = `verdict-banner ${verdict.className}`;

  $.verdict.textContent = verdict.label;
  $.verdictNote.textContent = verdict.note;

  // AMC 卡
  $.amcInitialOut.textContent = `−${currency.format(result.funds.amc)}`;
  $.amcChannelFeeLine.textContent = currency.format(result.totalChannelFee);
  $.amcInterestLine.textContent = currency.format(result.totalAmcInterestPaid);
  $.amcMgmtLine.textContent = currency.format(result.totalMgmtFee);
  $.amcPrincipalLine.textContent = currency.format(result.totalAmcPrincipalPaid);
  $.amcNetProfit.textContent = currency.format(result.amcNetProfit);
  $.amcIrr.textContent = percent(result.amcIrr);
  $.amcMoic.textContent = Number.isFinite(result.amcMoic)
    ? `${result.amcMoic.toFixed(2)}x`
    : "-";
  $.amcRoi.textContent = Number.isFinite(result.amcRoi)
    ? percent(result.amcRoi, 1)
    : "无配资";
  $.amcPayback.textContent =
    result.amcPaybackQuarter !== null
      ? `Q${result.amcPaybackQuarter}`
      : result.funds.amc > 0
        ? "5年未回本"
        : "无配资";

  // Mezz 卡
  $.mezzInitialOut.textContent = `−${currency.format(result.funds.mezz)}`;
  $.mezzInterestLine.textContent = currency.format(result.totalMezzInterestPaid);
  $.mezzPrincipalLine.textContent = currency.format(result.totalMezzPrincipalPaid);
  $.mezzNetProfit.textContent = currency.format(result.mezzNetProfit);
  $.mezzIrr.textContent = percent(result.mezzIrr);
  $.mezzMoic.textContent = Number.isFinite(result.mezzMoic)
    ? `${result.mezzMoic.toFixed(2)}x`
    : "-";
  $.mezzRoi.textContent = Number.isFinite(result.mezzRoi)
    ? percent(result.mezzRoi, 1)
    : "无配资";
  $.mezzPayback.textContent =
    result.mezzPaybackQuarter !== null
      ? `Q${result.mezzPaybackQuarter}`
      : result.funds.mezz > 0
        ? "5年未回本"
        : "无配资";

  // 劣后卡
  $.equityInitialOut.textContent = `−${currency.format(result.funds.equity)}`;
  $.equityChannelFee.textContent = `−${currency.format(result.totalChannelFee)}`;
  $.equityRecoveryShare.textContent = `+${currency.format(result.totalResidual)}`;
  $.equityRebate.textContent = `+${currency.format(result.totalRebate)}`;
  $.equityOverhead.textContent = `−${currency.format(result.totalOverhead)}`;
  $.equityMezzInterest.textContent = `−${currency.format(result.totalMezzInterestPaid)}`;
  $.equityNetProfit.textContent = currency.format(result.equityProfit);
  $.equityIrr.textContent = percent(result.irr);
  $.equityMoic.textContent = Number.isFinite(result.moic)
    ? `${result.moic.toFixed(2)}x`
    : "-";
  $.equityPayback.textContent =
    result.paybackQuarter !== null
      ? `Q${result.paybackQuarter}`
      : "5年未回本";
}

// ============ 5 年资金流向总览 ============

function renderFlowOverview(result, values) {
  const recovery = result.totalRecovery;
  const amcCashReceived = result.totalChannelFee + result.totalAmcInterestPaid + result.totalMgmtFee + result.totalAmcPrincipalPaid;
  const mezzCashReceived = result.totalMezzInterestPaid + result.totalMezzPrincipalPaid;
  const equityNet = result.equityProfit + result.funds.equity + result.totalChannelFee;

  let collectionAndLegal = 0;
  for (const row of result.rows) collectionAndLegal += row.collectionFee + row.legalCost;
  const externalCost = collectionAndLegal + result.totalOverhead;

  $.flowDiagram.innerHTML = `
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
}

// ============ 季度现金分配瀑布图 ============

function buildCashflowSeries(result) {
  const series = [];
  series.push({
    index: 0,
    label: "Q0",
    quarter: 0,
    amc: -result.funds.amc,
    mezz: -result.funds.mezz,
    equity: -result.funds.equity,
    isInitial: true,
  });
  result.rows.forEach((row, idx) => {
    const amcFlow = row.amcInterestPaid + row.mgmtFee + row.amcPrincipalPaid + (row.quarter === 1 ? result.totalChannelFee : 0);
    const mezzFlow = row.mezzInterestDue + row.mezzPrincipalPaid;
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

  ctx.strokeStyle = "#9aa6a0";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, yZero);
  ctx.lineTo(width - pad.right, yZero);
  ctx.stroke();

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

  ctx.fillStyle = "#66736b";
  const labelQuarters = [0, 1, 4, 8, 12, 16, 20];
  labelQuarters.forEach((q) => {
    const s = series.find((x) => x.quarter === q);
    if (!s) return;
    const cx = xGroup(s.index);
    ctx.fillText(`Q${q}`, cx - 10, height - 16);
  });

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
  const totalGroups = cachedResult.rows.length + 1;
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

function renderInsights(result, values, breakEven, baseline) {
  const totalRecoveryRate = values.faceValue > 0 ? (result.totalRecovery / values.faceValue) * 100 : 0;
  const channelFee = result.totalChannelFee;
  const mgmtFee = result.totalMgmtFee;
  const amcRevenueRatio =
    result.funds.equity + result.equityProfit > 0 && channelFee + mgmtFee > 0
      ? ((channelFee + mgmtFee) / (result.funds.equity + result.equityProfit)) * 100
      : 0;

  // 对比式折扣折损: 若不打折, 期末剩余本金应为 baseline.remainingAssetPrincipal
  const discountRate = values.discountRecoveryRate || 0;
  const discountInsight = {
    title: `折扣折损：${currency.format(result.totalWritedown)}`,
    body: discountRate > 0 && baseline
      ? `若不打折, 期末剩余本金应为 ${currency.format(baseline.remainingAssetPrincipal)}; 当前 ${currency.format(result.remainingAssetPrincipal)}, 即"白送"了 ${currency.format(result.totalWritedown)} 资产本金给持卡人。`
      : discountRate > 0
        ? `因 ${priceRate(discountRate)} 折扣, 5 年累计额外抹销本金 ${currency.format(result.totalWritedown)}（实际回款不变, 仅影响后续季度潜在回收能力）。`
        : `当前无折扣 (0%) — 期末剩余本金 ${currency.format(result.remainingAssetPrincipal)} 即理论最小值。`,
    tone: result.totalWritedown > 0 ? "warn" : "good",
  };

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
          ? result.funds.mezz * (values.mezzRate / 100 / 4)
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
    discountInsight,
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

  $.insights.innerHTML = items
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

// ============ 季度明细表 ============

function renderTable(result) {
  const rows = result.rows;
  const equityInitial = -result.funds.equity;
  const amcInitial = -result.funds.amc;
  const mezzInitial = -result.funds.mezz;
  const equityChannelFee = -result.totalChannelFee;
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
  $.projectionRows.innerHTML = q0Row + periodRows;
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
        { ...values, purchaseDiscount: discount },
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

  $.sensitivityGrid.innerHTML = cells.join("");
}

function compactCurrency(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 100000000) return `${sign}${(abs / 100000000).toFixed(1)}亿`;
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万`;
  return `${sign}${currency.format(abs).replace(/[^\d.-]/g, "")}`;
}

function updateModel() {
  const values = getInputs();
  const result = project(values);
  // baseline (一次额外 project) 用于投委对比式, ~15ms
  const baseline = project({ ...values, discountRecoveryRate: 0 });
  cachedResult = result;
  if (currentHoverIndex >= result.rows.length + 1) currentHoverIndex = -1;

  // 第 1 帧: 用户最关心的数字 + 流程图 (~30ms, 用户 16ms 看到)
  renderMetrics(result, values);
  renderFlowOverview(result, values);

  // 第 2 帧: 明细表 + 投委（breakEven 跑完后才执行）
  requestAnimationFrame(() => {
    renderTable(result);
    // findBreakEvenMultiplier (~2.8s) 也放第 2 帧异步算, 算完后再 renderInsights
    const breakEven = findBreakEvenMultiplier(values);
    renderInsights(result, values, breakEven, baseline);
  });

  // 第 3 帧: 敏感性 + Canvas
  requestAnimationFrame(() => {
    renderSensitivity(values);
    drawCashflowChart(result);
  });
}

// input 防抖: 拖滑块时连续触发合并到下一帧
let pendingUpdate = null;
form.addEventListener("input", () => {
  if (pendingUpdate) return;
  pendingUpdate = requestAnimationFrame(() => {
    pendingUpdate = null;
    updateModel();
  });
});
resetButton.addEventListener("click", setDefaults);
window.addEventListener("resize", () => {
  if (pendingUpdate) cancelAnimationFrame(pendingUpdate);
  pendingUpdate = null;
  updateModel();
});

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
    const input = form.querySelector(`#${field}`);
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
  $.historyPanel.hidden = !$.historyPanel.hidden;
}

function flashHistoryButton(text) {
  const original = $.saveHistoryButton.innerHTML;
  $.saveHistoryButton.innerHTML = `<span class="btn-icon" aria-hidden="true">✓</span> ${text}`;
  $.saveHistoryButton.disabled = true;
  setTimeout(() => {
    $.saveHistoryButton.innerHTML = original;
    $.saveHistoryButton.disabled = false;
  }, 1200);
}

function renderHistoryList() {
  const items = getHistory();
  $.historyCount.textContent = String(items.length);
  $.historyCount.classList.toggle("is-empty", items.length === 0);

  if (!items.length) {
    $.historyList.innerHTML = `<div class="history-empty">还没有保存的快照。点击"保存当前"记录一组参数，刷新或关闭浏览器后仍可恢复。</div>`;
    return;
  }

  $.historyList.innerHTML = items
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

$.saveHistoryButton.addEventListener("click", saveCurrentSnapshot);
$.toggleHistoryButton.addEventListener("click", toggleHistoryPanel);
$.clearHistoryButton.addEventListener("click", clearAllSnapshots);
document.querySelector("#historyList").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === "load") loadSnapshot(id);
  else if (btn.dataset.action === "delete") deleteSnapshot(id);
});

renderHistoryList();

setDefaults();