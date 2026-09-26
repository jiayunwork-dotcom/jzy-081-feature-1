// 核算编排层：把生存递推、寿险、年金、两全各模块按一次请求串起来。
//
// 并发隔离：每次调用都在自己的栈帧内新建 kp / deathInYear 等中间累积量，
// 全程不碰任何模块级可变状态，多个核算请求并发时各算各的、互不串写。

import { discountFactor, discountRate } from './discount.js';
import { survivalProbabilities } from './survival.js';
import { wholeLifeInsuranceAPV } from './wholeLife.js';
import { annuityDueAPV } from './annuity.js';
import {
  pureEndowmentAPV,
  termInsuranceAPV,
} from './endowment.js';
import { wholeLifeNetPremium, endowmentNetPremium } from './premium.js';
import {
  prospectiveReservePerUnit,
  retrospectiveReservePerUnit,
  recurrenceSteps,
  withinTolerance,
} from './reserve.js';

const EPS = 1e-12;

/**
 * 终身寿险 + 期初生存年金（单位保额），并回算恒等式闭合差供校算。
 * 输入必须已经过参数校验层校验。
 *
 * @param {{ qx: number[], interestRate: number }} input
 * @returns {{
 *   wholeLifeInsurance: number,
 *   annuityDue: number,
 *   identityResidual: number,
 *   discountFactor: number,
 *   discountRate: number
 * }}
 */
export function valueLifeTable({ qx, interestRate }) {
  const survival = survivalProbabilities(qx);
  const wholeLifeInsurance = wholeLifeInsuranceAPV(survival, interestRate);
  const annuityDue = annuityDueAPV(survival, interestRate);
  const d = discountRate(interestRate);

  return {
    wholeLifeInsurance,
    annuityDue,
    // 恒等式基准：1 = A_x + d * ä_x（d = i/(1+i)）
    identityResidual: 1 - (wholeLifeInsurance + d * annuityDue),
    identityClosed:
      Math.abs(1 - (wholeLifeInsurance + d * annuityDue)) < EPS,
    discountFactor: discountFactor(interestRate),
    discountRate: d,
  };
}

/**
 * 两全保险净保费及定期死亡、纯生存两个分项。
 * 同时随附终身寿险/年金现值，方便调用方一次拿全口径。
 *
 * @param {{ qx: number[], interestRate: number, years: number, sumInsured: number }} input
 * @returns {object}
 */
export function valueEndowment({ qx, interestRate, years, sumInsured }) {
  const survival = survivalProbabilities(qx);

  const wholeLifeInsurance = wholeLifeInsuranceAPV(survival, interestRate);
  const annuityDue = annuityDueAPV(survival, interestRate);
  const d = discountRate(interestRate);

  const termInsurancePerUnit = termInsuranceAPV(survival, interestRate, years);
  const pureEndowmentPerUnit = pureEndowmentAPV(survival, interestRate, years);
  const endowmentPerUnit = termInsurancePerUnit + pureEndowmentPerUnit;

  const money = (perUnit) => perUnit * sumInsured;

  return {
    years,
    sumInsured,
    // 单位保额口径
    perUnit: {
      termInsurance: termInsurancePerUnit,
      pureEndowment: pureEndowmentPerUnit,
      endowment: endowmentPerUnit,
    },
    // 乘以保额后的金额口径（保额放大几倍，各项同比例放大）
    money: {
      termInsurance: money(termInsurancePerUnit),
      pureEndowment: money(pureEndowmentPerUnit),
      netPremium: money(endowmentPerUnit),
    },
    // 随附终身口径，便于对账
    wholeLifeInsurance,
    annuityDue,
    identityResidual: 1 - (wholeLifeInsurance + d * annuityDue),
    identityClosed:
      Math.abs(1 - (wholeLifeInsurance + d * annuityDue)) < EPS,
    discountFactor: discountFactor(interestRate),
    discountRate: d,
  };
}

/**
 * 一张按年缴费保单的公共口径：保障/缴费年限、均衡净保费（单位 + 金额）。
 * 缴费期 = 保障期（全期缴费）：终身险缴到终龄（表长），两全缴到保障年限满。
 *
 * @param {{ qx: number[], interestRate: number, productType: string,
 *           years?: number, sumInsured: number }} input
 * @returns {object}
 */
export function valuePremium({ qx, interestRate, productType, years, sumInsured }) {
  const survival = survivalProbabilities(qx);
  const termYears = productType === 'endowment' ? years : qx.length;

  const premium = productType === 'endowment'
    ? endowmentNetPremium(survival, interestRate, years)
    : wholeLifeNetPremium(survival, interestRate);
  const { benefitAPV, annuityAPV, premiumPerUnit } = premium;

  // 等价原则残差：P·ä − 给付现值（单位口径下应恰为 0）
  const equivalenceResidual = premiumPerUnit * annuityAPV - benefitAPV;

  return {
    productType,
    years: termYears,
    premiumYears: termYears,
    sumInsured,
    perUnit: {
      benefitAPV,
      annuityAPV,
      netPremium: premiumPerUnit,
    },
    money: {
      benefitAPV: benefitAPV * sumInsured,
      annuityAPV: annuityAPV * sumInsured,
      netPremium: premiumPerUnit * sumInsured,
    },
    // 等价原则基准：P · 保费年金现值 = 给付现值
    equivalenceResidual,
    equivalenceClosed: withinTolerance(equivalenceResidual, 0, benefitAPV),
    discountFactor: discountFactor(interestRate),
    discountRate: discountRate(interestRate),
  };
}

/**
 * 一张按年缴费保单的完整核算：均衡净保费 + 逐年净准备金（往后看 / 回算两条路径）
 * + 逐年递推校验 + 签单/满期闭合检查。
 *
 * @param {{ startAge: number, qx: number[], interestRate: number,
 *           productType: string, years?: number, sumInsured: number }} input
 * @returns {object}
 */
export function valuePolicy(input) {
  const { startAge, qx, interestRate, productType, sumInsured } = input;
  const base = valuePremium(input);
  const survival = survivalProbabilities(qx); // 回算口径始终从签单起点起算
  const termYears = base.years;
  const premiumPerUnit = base.perUnit.netPremium;
  const premiumAnnual = base.money.netPremium;

  const reserves = [];
  for (let t = 0; t <= termYears; t++) {
    const proUnit = prospectiveReservePerUnit({
      qx,
      interestRate,
      productType,
      termYears,
      premiumPerUnit,
      t,
    });
    const retroUnit = retrospectiveReservePerUnit({
      survival,
      interestRate,
      premiumPerUnit,
      t,
    });
    const prospective = proUnit * sumInsured;
    const retrospective = retroUnit === null ? null : retroUnit * sumInsured;
    reserves.push({
      t,
      age: startAge + t,
      prospective,
      retrospective,
      // 两条路径的差：仅数值误差量级；回算无定义的年为 null
      pathDifference: retrospective === null ? null : prospective - retrospective,
    });
  }

  const recurrence = recurrenceSteps({
    qx,
    interestRate,
    reservesMoney: reserves.map((r) => r.prospective),
    premiumAnnual,
    sumInsured,
  });

  // 回算有定义的年里，两条路径的最大差异
  const pathDifferences = reserves
    .map((r) => r.pathDifference)
    .filter((d) => d !== null)
    .map((d) => Math.abs(d));
  const maxPathDifference = pathDifferences.length
    ? Math.max(...pathDifferences)
    : 0;

  const issueReserve = reserves[0].prospective;
  const terminalReserve = reserves[reserves.length - 1];

  return {
    ...base,
    reserves,
    recurrence: {
      formula:
        '(_t V + P)(1+i) = q_{x+t}*S + p_{x+t}*_(t+1)V',
      steps: recurrence,
      maxAbsResidual: Math.max(
        ...recurrence.map((s) => Math.abs(s.residual)),
      ),
      closed: recurrence.every((s) => s.closed),
    },
    checks: {
      // 签单时点准备金为 0（等价原则）
      reserveAtIssue: {
        value: issueReserve,
        residual: issueReserve,
        closed: withinTolerance(issueReserve, 0, sumInsured),
      },
      // 两全满期、生存金给付前一刻准备金 = 保额；终身险此项为 null
      maturityReserve: productType === 'endowment'
        ? {
            value: terminalReserve.prospective,
            sumInsured,
            residual: terminalReserve.prospective - sumInsured,
            closed: withinTolerance(
              terminalReserve.prospective,
              sumInsured,
              sumInsured,
            ),
          }
        : null,
      // 终身险到期末收敛：终龄后无存续保单，准备金为 0
      terminalReserveZero: productType === 'endowment'
        ? null
        : {
            value: terminalReserve.prospective,
            residual: terminalReserve.prospective,
            closed: withinTolerance(terminalReserve.prospective, 0, sumInsured),
          },
      // 往后看与回算两条路径逐年对得上
      pathsAgree: {
        maxAbsDifference: maxPathDifference,
        closed: withinTolerance(maxPathDifference, 0, sumInsured),
      },
      recurrenceClosed: recurrence.every((s) => s.closed),
    },
  };
}
