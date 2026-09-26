// 逐年净准备金模块（net premium reserve）
//
// 对一张按年缴费的保单，给出存续期内每个保单年度末的净准备金，三条口径：
//
// 1) 往后看（prospective）：站在第 t 个保单年度末往后看
//      _t V = APV_{x+t}(剩余给付) − P · APV_{x+t}(剩余净保费)
//    生存概率与贴现幂次以「人当下已经活到 x+t」为新起点重新起算：
//    用 qx 第 t 项起的子表重新跑 survivalProbabilities，
//    而不是拿签单时的现值口径直接截一段。
//
// 2) 回算（retrospective）：从签单时点往过去看
//      _t V = [P · ä_{x:t} − A¹_{x:t}] / _t E_x
//    即「过去已收净保费的积累现值 − 已发生给付的积累现值」，
//    除以 _t E_x 相当于在仍生存者之间分摊死者留下的积累。
//    与往后看是同一笔负债的两条路径，只应差在数值误差量级。
//    _t p_x = 0 的时点回算为 0/0 不定式（没有生存者可分摊），返回 null。
//
// 3) 递推校验（把各年准备金串起来的关系）：
//      (_t V + P)(1 + i) = q_{x+t} · S + p_{x+t} · _{t+1} V
//    某年末准备金加年初净保费滚一年利息 = 当年死亡按保额赔付的期望
//    + 活过这一年的人带到下一年末的准备金。
//
// 边界（精算上躲不开的闭合条件）：
//   t = 0（签单时刻，未收保费未给付）：_0 V = 0（等价原则的直接后果）。
//   两全 t = n（满期、生存金给付前一刻）：_n V = 1（单位保额）。
//   终身险 t = 表长（终龄之后）：已无存续保单，_t V = 0。

import { survivalProbabilities } from './survival.js';
import { wholeLifeInsuranceAPV } from './wholeLife.js';
import { temporaryAnnuityDueAPV } from './annuity.js';
import {
  termInsuranceAPV,
  pureEndowmentAPV,
  endowmentInsuranceAPV,
} from './endowment.js';

// 相对容差：金额口径下残差随保额放大，按量级放宽
const REL_TOL = 1e-9;

export function withinTolerance(a, b, scale = 1) {
  return Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(scale));
}

/**
 * 往后看口径：第 t 个保单年度末的净准备金（单位保额）。
 *
 * @param {{ qx: number[], interestRate: number, productType: string,
 *           termYears: number, premiumPerUnit: number, t: number }} args
 *   termYears 保障年限（= 缴费期数）：两全为 n，终身险为表长
 *   t         第 t 个保单年度末（0 <= t <= termYears）
 * @returns {number} 单位保额净准备金 _t V
 */
export function prospectiveReservePerUnit({
  qx,
  interestRate,
  productType,
  termYears,
  premiumPerUnit,
  t,
}) {
  const remaining = termYears - t; // 剩余保障年数（全期缴费下 = 剩余缴费期数）

  if (remaining <= 0) {
    // 保障终止时点：两全在满期生存金给付前，负债恰为保额（单位 1）；
    // 终身险到终龄后保单全部了结，无剩余负债。
    return productType === 'endowment' ? 1 : 0;
  }

  // 以「已活到 x+t」为新起点重新递推生存概率（不截签单口径）
  const sub = survivalProbabilities(qx.slice(t));
  const benefitAPV = productType === 'endowment'
    ? endowmentInsuranceAPV(sub, interestRate, remaining).endowment
    : wholeLifeInsuranceAPV(sub, interestRate);
  const annuityAPV = temporaryAnnuityDueAPV(sub, interestRate, remaining);

  return benefitAPV - premiumPerUnit * annuityAPV;
}

/**
 * 回算口径：第 t 个保单年度末的净准备金（单位保额）。
 * 从签单时点的整表生存递推出发，把已收保费与已发生给付各自积累到时刻 t。
 *
 * @param {{ survival: { kp: number[], deathInYear: number[] },
 *           interestRate: number, premiumPerUnit: number, t: number }} args
 * @returns {number|null} 单位保额净准备金；_t p_x = 0 时无定义，返回 null
 */
export function retrospectiveReservePerUnit({
  survival,
  interestRate,
  premiumPerUnit,
  t,
}) {
  const tE = pureEndowmentAPV(survival, interestRate, t); // _t E_x
  if (tE <= 0) {
    // 没人能活到该时点：积累无法在生存者间分摊（0/0 不定式）
    return null;
  }
  const premiumsAccum = premiumPerUnit
    * temporaryAnnuityDueAPV(survival, interestRate, t); // P · ä_{x:t}
  const benefitsAccum = termInsuranceAPV(survival, interestRate, t); // A¹_{x:t}
  return (premiumsAccum - benefitsAccum) / tE;
}

/**
 * 递推校验：对相邻两个保单年度末逐段核对
 *   (_t V + P)(1 + i) = q_{x+t} · S + p_{x+t} · _{t+1} V
 * 全部在金额口径下计算（直接乘保额，避免先单位后放大引入额外舍入）。
 *
 * @param {{ qx: number[], interestRate: number, reservesMoney: number[],
 *           premiumAnnual: number, sumInsured: number }} args
 *   reservesMoney[t] = 第 t 个保单年度末准备金（金额），t = 0..termYears
 * @returns {{ fromT: number, toT: number, lhs: number, rhs: number,
 *             residual: number, closed: boolean }[]}
 */
export function recurrenceSteps({
  qx,
  interestRate,
  reservesMoney,
  premiumAnnual,
  sumInsured,
}) {
  const steps = [];
  for (let t = 0; t < reservesMoney.length - 1; t++) {
    const lhs = (reservesMoney[t] + premiumAnnual) * (1 + interestRate);
    const rhs = qx[t] * sumInsured + (1 - qx[t]) * reservesMoney[t + 1];
    steps.push({
      fromT: t,
      toT: t + 1,
      lhs,
      rhs,
      residual: lhs - rhs,
      closed: withinTolerance(lhs, rhs, sumInsured),
    });
  }
  return steps;
}
