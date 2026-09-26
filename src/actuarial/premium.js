// 均衡年缴净保费模块（level annual net premium）
//
// 等价原则（equivalence principle）：签单那一刻
//   未来各期净保费收入的现值 = 未来各期给付的现值
// 保费每年年初缴、缴到规定期数为止（全期缴费）：
//   终身寿险：缴到终龄，缴费期 = 表长，保费年金即全期期初年金 ä_x
//   n 年两全：缴到保障年限满，缴费期 = n，保费年金为 n 年期初年金 ä_{x:n}
//
// 反解不另起算法，直接落在服务已有的现值口径上：
//   P = 给付趸缴现值 / 保费年金现值
//     终身：P_x     = A_x     / ä_x
//     两全：P_{x:n} = A_{x:n} / ä_{x:n}

import { wholeLifeInsuranceAPV } from './wholeLife.js';
import { annuityDueAPV, temporaryAnnuityDueAPV } from './annuity.js';
import { endowmentInsuranceAPV } from './endowment.js';

/**
 * 终身寿险均衡年缴净保费（单位保额）：P_x = A_x / ä_x。
 * @param {{ kp: number[], deathInYear: number[] }} survival
 * @param {number} i 年利率
 * @returns {{ benefitAPV: number, annuityAPV: number, premiumPerUnit: number }}
 */
export function wholeLifeNetPremium(survival, i) {
  const benefitAPV = wholeLifeInsuranceAPV(survival, i);
  const annuityAPV = annuityDueAPV(survival, i);
  return {
    benefitAPV,
    annuityAPV,
    premiumPerUnit: benefitAPV / annuityAPV,
  };
}

/**
 * n 年两全均衡年缴净保费（单位保额）：P_{x:n} = A_{x:n} / ä_{x:n}。
 * @param {{ kp: number[], deathInYear: number[] }} survival
 * @param {number} i 年利率
 * @param {number} n 保障年限（= 缴费期数，整数，1 <= n <= 表长）
 * @returns {{ benefitAPV: number, annuityAPV: number, premiumPerUnit: number }}
 */
export function endowmentNetPremium(survival, i, n) {
  const benefitAPV = endowmentInsuranceAPV(survival, i, n).endowment;
  const annuityAPV = temporaryAnnuityDueAPV(survival, i, n);
  return {
    benefitAPV,
    annuityAPV,
    premiumPerUnit: benefitAPV / annuityAPV,
  };
}
