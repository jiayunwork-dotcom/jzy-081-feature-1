// 逐年净准备金模块 —— 回算（retrospective）口径
//
// 换一条路：不往后看，而是回头看已发生的现金流。
// 第 t 个保单年度末，每个仍生存者名下积累的准备金：
//   _t V = ( P · ä_{x:t} − A¹_{x:t} ) / _t E_x
//        = ( 过去已收净保费的积累现值 − 已发生死亡给付的积累现值 ) ÷ 生存者分摊因子
//
// 与往后看口径在精算上等价（同一套生存递推与贴现换算下的恒等变形），
// 两条路径只应差在数值误差量级 —— 这一点由测试与响应里的 pathsAgree 检查钉死。
//
// 边界：当 _t p_x = 0（生存者已灭绝，例如终身险终龄之后），
// 分子分母同时为 0，积累口径在数学上无定义，本模块返回 null，
// 由编排层以同点的往后看边界值补齐（该时点之后不再有任何现金流）。

import { survivalProbabilities } from './survival.js';
import { termInsuranceAPV, pureEndowmentAPV } from './endowment.js';
import { temporaryAnnuityDueAPV } from './annuity.js';

/**
 * 从第 1 年年末到第 term 年年末的回算准备金序列（单位保额）。
 * 序列元素为 number；生存者灭绝的时点为 null（见模块头注释）。
 *
 * @param {{ qx: number[], interestRate: number, premiumPerUnit: number,
 *           term: number }} input
 *        term 为保障期数（终身险 = 表长，两全 = 保障年限）；
 *        缴费期不短于 term，故前 term 年的保费流就是限期年金 ä_{x:t}
 * @returns {(number|null)[]}
 */
export function retrospectiveReserveSchedule({ qx, interestRate, premiumPerUnit, term }) {
  // 回算口径站在签单时点积累，用整张表的生存递推（不切片）
  const survival = survivalProbabilities(qx);
  const schedule = new Array(term);

  for (let t = 1; t <= term; t++) {
    const share = pureEndowmentAPV(survival, interestRate, t); // _t E_x
    if (share === 0) {
      schedule[t - 1] = null; // 无生存者可分摊，0/0 无定义
      continue;
    }
    const premiumsAccumulated = premiumPerUnit
      * temporaryAnnuityDueAPV(survival, interestRate, t);
    const benefitsAccumulated = termInsuranceAPV(survival, interestRate, t);
    schedule[t - 1] = (premiumsAccumulated - benefitsAccumulated) / share;
  }

  return schedule;
}
