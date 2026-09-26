// 准备金递推关系校验模块
//
// 相邻两个保单年度末的净准备金必须满足（金额口径）：
//   (_t V + P) · (1 + i) = q_{x+t} · S + p_{x+t} · _{t+1} V
//
// 含义：某年末准备金加上年初收取的净保费，滚一年利息之后，
// 应当正好覆盖这一年内死亡按保额 S 赔付的期望支出，
// 外加活过这一年的人带到下一年末的准备金。
//
// 本模块只做校验：给定保费与准备金序列，逐步回算每一年的残差，
// 供编排层与测试把这条递推钉死；不参与准备金本身的计算。

/**
 * 逐步校验准备金递推关系，返回每一步的残差（金额口径）。
 *
 * @param {{ qx: number[], interestRate: number, premium: number,
 *           sumInsured: number, reserves: number[] }} input
 *        premium 为均衡年缴净保费（金额），reserves 为 [_1V, ..., _TV]
 *        （第 0 步从 _0V = 0 出发，等价原则保证其成立）
 * @returns {number[]} 第 t 项 = (_tV + P)(1+i) − ( q_{x+t}·S + p_{x+t}·_{t+1}V )
 */
export function recursionResiduals({ qx, interestRate, premium, sumInsured, reserves }) {
  const residuals = new Array(reserves.length);
  let carried = 0; // _0 V = 0：签单时点还未收保费、未发生给付

  for (let t = 0; t < reserves.length; t++) {
    const survived = 1 - qx[t]; // p_{x+t}
    const accumulated = (carried + premium) * (1 + interestRate);
    const required = qx[t] * sumInsured + survived * reserves[t];
    residuals[t] = accumulated - required;
    carried = reserves[t];
  }

  return residuals;
}
