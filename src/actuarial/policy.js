// 保单级核算编排：均衡净保费 -> 逐年净准备金（往后看 / 回算两条路径）
// -> 递推关系校验，一次请求全部串起来。
//
// 与 valuation.js 同属编排层：只拼装各计算模块的结果，不自带计算口径。
// 并发隔离：每次调用在自己的栈帧内新建全部中间量，无模块级可变状态。

import { discountFactor, discountRate } from './discount.js';
import { levelNetPremium } from './premium.js';
import {
  prospectiveReserveAt,
  prospectiveReserveSchedule,
} from './reserve.js';
import { retrospectiveReserveSchedule } from './retrospective.js';
import { recursionResiduals } from './recursion.js';

// 数值容差：金额口径的残差随保额放大，按 max(1, 保额) 相对化
const toleranceFor = (sumInsured) => 1e-9 * Math.max(1, sumInsured);
const maxAbs = (arr) => arr.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/**
 * 一张按年缴费保单的完整核算：均衡净保费 + 逐年净准备金序列 + 递推校验。
 * 输入必须已经过参数校验层校验。
 *
 * @param {{ qx: number[], interestRate: number, sumInsured: number,
 *           product: { type: 'wholeLife' } | { type: 'endowment', years: number } }} input
 * @returns {object} 保费、逐年准备金（往后看/回算双口径）、各项闭合检查
 */
export function valuePolicy({ qx, interestRate, product, sumInsured }) {
  // 1) 均衡年缴净保费（等价原则：保费现值 = 给付现值）
  const premium = levelNetPremium({ qx, interestRate, product });
  const premiumPerUnit = premium.perUnit;
  const term = premium.coverageYears;

  // 2) 逐年准备金：往后看口径为主序列
  const prospectivePerUnit = prospectiveReserveSchedule({
    qx, interestRate, product, premiumPerUnit,
  });

  // 3) 换一路回算口径交叉核对；生存者灭绝的时点（null）以同点
  //    往后看边界值补齐 —— 该时点之后不再有任何现金流，边界值即合同义务
  const retrospectiveRaw = retrospectiveReserveSchedule({
    qx, interestRate, premiumPerUnit, term,
  });
  const retrospectivePerUnit = retrospectiveRaw.map((value, idx) => (
    value === null ? prospectivePerUnit[idx] : value
  ));

  // 4) 签单时点准备金（等价原则要求为 0）
  const initialPerUnit = prospectiveReserveAt({
    qx, interestRate, product, premiumPerUnit, t: 0,
  });

  // 5) 金额口径
  const annualPremium = premiumPerUnit * sumInsured;
  const prospective = prospectivePerUnit.map((v) => v * sumInsured);
  const retrospective = retrospectivePerUnit.map((v) => v * sumInsured);
  const initialReserve = initialPerUnit * sumInsured;

  // 6) 递推关系逐步残差：(V_t + P)(1+i) = q_{x+t}·S + p_{x+t}·V_{t+1}
  const residuals = recursionResiduals({
    qx, interestRate, premium: annualPremium, sumInsured, reserves: prospective,
  });

  const tolerance = toleranceFor(sumInsured);
  const pathDifferences = prospective.map((v, idx) => v - retrospective[idx]);
  const expectedTerminal = product.type === 'endowment' ? sumInsured : 0;

  return {
    product: product.type === 'endowment'
      ? {
        type: 'endowment',
        years: product.years,
        premiumYears: premium.premiumYears,
        coverageYears: term,
      }
      : {
        type: 'wholeLife',
        premiumYears: premium.premiumYears,
        coverageYears: term,
      },
    sumInsured,
    discountFactor: discountFactor(interestRate),
    discountRate: discountRate(interestRate),
    netPremium: {
      perUnit: premiumPerUnit,
      annual: annualPremium,
      // 反解依据（单位保额）：P = 给付现值 / 保费年金现值
      benefitAPVPerUnit: premium.benefitAPV,
      premiumAnnuityAPVPerUnit: premium.premiumAnnuityAPV,
      equivalence: {
        formula: 'P * ä = A（签单时点保费现值 = 给付现值）',
        residual: premium.benefitAPV - premiumPerUnit * premium.premiumAnnuityAPV,
        closed: Math.abs(
          premium.benefitAPV - premiumPerUnit * premium.premiumAnnuityAPV,
        ) < 1e-12,
      },
    },
    initialReserve,
    reserves: prospective.map((value, idx) => ({
      year: idx + 1,
      prospective: value,
      retrospective: retrospective[idx],
      // 回算口径在该时点是否因生存者灭绝而以边界值补齐
      retrospectiveBoundaryFilled: retrospectiveRaw[idx] === null,
      // 第 idx → idx+1 步（以上一年末准备金滚到本年末）的递推残差
      recursionResidual: residuals[idx],
      perUnit: {
        prospective: prospectivePerUnit[idx],
        retrospective: retrospectivePerUnit[idx],
      },
    })),
    checks: {
      initialReserveZero: {
        formula: 'V_0 = 给付现值 − 保费现值 = 0（等价原则）',
        value: initialReserve,
        tolerance,
        passed: Math.abs(initialReserve) <= tolerance,
      },
      recursionClosed: {
        formula: '(V_t + P)·(1+i) = q_{x+t}·S + p_{x+t}·V_{t+1}',
        maxAbsResidual: maxAbs(residuals),
        tolerance,
        passed: maxAbs(residuals) <= tolerance,
      },
      pathsAgree: {
        formula: '往后看口径 = 回算口径（仅差数值误差）',
        maxAbsDifference: maxAbs(pathDifferences),
        tolerance,
        passed: maxAbs(pathDifferences) <= tolerance,
      },
      terminalReserve: {
        formula: product.type === 'endowment'
          ? '两全满期、给付纯生存金之前：V_n = S'
          : '终身险到终龄、全部给付了结之后：V = 0',
        value: prospective[term - 1],
        expected: expectedTerminal,
        tolerance,
        passed: Math.abs(prospective[term - 1] - expectedTerminal) <= tolerance,
      },
    },
  };
}
