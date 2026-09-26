// 均衡年缴净保费反解模块（精算等价原则）
//
// 签单那一刻：未来净保费收入现值 = 未来给付现值
//   终身寿险：P · ä_x     = A_x        （保费每年年初缴，缴到终龄）
//   n 年两全：P · ä_{x:n} = A_{x:n}    （保费每年年初缴，缴到保障年限满）
//
// 两边的现值口径全部复用既有模块（生存递推 / 寿险 / 年金 / 两全），
// 不另起一套算法，保证「趸缴现值」与「年缴保费 / 准备金」口径永远一致。

import { survivalProbabilities } from './survival.js';
import { wholeLifeInsuranceAPV } from './wholeLife.js';
import { annuityDueAPV, temporaryAnnuityDueAPV } from './annuity.js';
import { endowmentInsuranceAPV } from './endowment.js';

/**
 * 反解均衡年缴净保费（单位保额口径）。
 * 输入必须已经过参数校验层校验。
 *
 * @param {{ qx: number[], interestRate: number,
 *           product: { type: 'wholeLife' } | { type: 'endowment', years: number } }} input
 * @returns {{
 *   perUnit: number,             // 单位保额下的均衡年缴净保费 P
 *   benefitAPV: number,          // 给付现值（趸缴口径，单位保额）
 *   premiumAnnuityAPV: number,   // 保费收入现值对应的年金现值 ä（单位保额）
 *   premiumYears: number,        // 缴费期数（终身险 = 表长，两全 = 保障年限）
 *   coverageYears: number        // 保障期数（准备金序列长度）
 * }}
 */
export function levelNetPremium({ qx, interestRate, product }) {
  const survival = survivalProbabilities(qx);

  if (product.type === 'wholeLife') {
    const benefitAPV = wholeLifeInsuranceAPV(survival, interestRate);
    const premiumAnnuityAPV = annuityDueAPV(survival, interestRate);
    return {
      perUnit: benefitAPV / premiumAnnuityAPV,
      benefitAPV,
      premiumAnnuityAPV,
      premiumYears: qx.length,
      coverageYears: qx.length,
    };
  }

  // 限期两全：缴费期 = 保障期 = n 年
  const n = product.years;
  const benefitAPV = endowmentInsuranceAPV(survival, interestRate, n).endowment;
  const premiumAnnuityAPV = temporaryAnnuityDueAPV(survival, interestRate, n);
  return {
    perUnit: benefitAPV / premiumAnnuityAPV,
    benefitAPV,
    premiumAnnuityAPV,
    premiumYears: n,
    coverageYears: n,
  };
}
