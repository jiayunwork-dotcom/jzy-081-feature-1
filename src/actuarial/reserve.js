// 逐年净准备金模块 —— 往后看（prospective）口径
//
// 第 t 个保单年度末的净准备金，站在该时点往后看：
//   _t V = 剩余给付现值 − 剩余净保费现值
// 关键：生存概率与贴现幂次都以「人已活到 x+t」为新起点重新起算
// （把 qx 从第 t 岁起切一段，重新走同一套生存递推），
// 而不是拿签单时的概率口径直接截一段。
//
// 边界约定（测试钉死）：
//   t = 0（签单时点）：_0 V = 给付现值 − P·年金现值 = 0（等价原则的直接后果）
//   终身险 t = 表长：剩余表为空，给付与保费现值均为 0，_V = 0（保单随终龄了结）
//   两全 t = n（满期）：剩余年限 0，对仍生存者立即欠付保额，
//                      单位保额准备金刚好是 1（_0E ≡ 1 的边界约定）

import { survivalProbabilities } from './survival.js';
import { wholeLifeInsuranceAPV } from './wholeLife.js';
import { annuityDueAPV, temporaryAnnuityDueAPV } from './annuity.js';
import { endowmentInsuranceAPV } from './endowment.js';

/**
 * 第 t 年年末的净准备金（单位保额，往后看口径）。
 *
 * @param {{ qx: number[], interestRate: number,
 *           product: { type: 'wholeLife' } | { type: 'endowment', years: number },
 *           premiumPerUnit: number, t: number }} input
 *        t 为签单后经过的年数（0 <= t <= 保障期数）
 * @returns {number}
 */
export function prospectiveReserveAt({ qx, interestRate, product, premiumPerUnit, t }) {
  // 以 x+t 为新起点重切生命表，走同一套生存概率递推
  const survival = survivalProbabilities(qx.slice(t));

  if (product.type === 'wholeLife') {
    const benefits = wholeLifeInsuranceAPV(survival, interestRate);
    const premiums = annuityDueAPV(survival, interestRate);
    return benefits - premiumPerUnit * premiums;
  }

  const remaining = product.years - t;
  if (remaining === 0) {
    // 满期那一刻、给付纯生存保险金之前：对仍生存者立即欠付单位保额 1
    return 1;
  }
  const benefits = endowmentInsuranceAPV(survival, interestRate, remaining).endowment;
  const premiums = temporaryAnnuityDueAPV(survival, interestRate, remaining);
  return benefits - premiumPerUnit * premiums;
}

/**
 * 从第 1 年年末到保单终止的净准备金序列（单位保额，往后看口径）。
 * 终身险排到终龄（表长项，末项为 0）；两全排到满期（n 项，末项为 1）。
 *
 * @param {{ qx: number[], interestRate: number, product: object,
 *           premiumPerUnit: number }} input
 * @returns {number[]} 第 t 项对应第 t+1 个保单年度末的准备金
 */
export function prospectiveReserveSchedule({ qx, interestRate, product, premiumPerUnit }) {
  const term = product.type === 'wholeLife' ? qx.length : product.years;
  const schedule = new Array(term);
  for (let t = 1; t <= term; t++) {
    schedule[t - 1] = prospectiveReserveAt({
      qx, interestRate, product, premiumPerUnit, t,
    });
  }
  return schedule;
}
