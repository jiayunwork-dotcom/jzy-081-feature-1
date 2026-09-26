// 示范生命表：数据刻意取简单小数，方便手工复算、对账口径。
//
// 两份都从 40 岁起截一段，年利率均取 25%（v = 0.8、d = 0.2，幂次手算无压力）。

export const SAMPLE_TABLES = [
  {
    id: 'standard-40',
    description:
      '标准示范表（40 岁起 5 岁）：逐年死亡率均非零，用于验证恒等式 1 = A_x + d·ä_x',
    startAge: 40,
    interestRate: 0.25,
    mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
    suggestedYears: 3,
    suggestedSumInsured: 100000,
    // 手算参考值（v=0.8, d=0.2），随附便于校算：
    handCheck: {
      survival: [1, 0.9, 0.72, 0.54, 0.27],
      wholeLifeInsurance: 0.4864256,
      annuityDue: 2.567872,
      identityA_plus_d_annuity: 1,
      term3: 0.28736,
      pureEndowment3: 0.27648,
      endowment3: 0.56384,
      // 均衡年缴净保费（全期缴费，单位保额）：
      //   终身 P_x   = A_x / ä_x = 0.4864256 / 2.567872
      //   两全 P_{x:3} = A_{x:3} / ä_{x:3}，ä_{x:3} = 1 + 0.9·0.8 + 0.72·0.64 = 2.1808
      premiumWholeLife: 0.18942751,
      temporaryAnnuity3: 2.1808,
      premiumEndowment3: 0.25854732,
      // 逐年净准备金（单位保额，列下标即第 t 个保单年度末，t=0 为签单时刻）：
      //   两全满期（t=3）前一刻准备金恰为保额 1
      reservesEndowment3: [0, 0.24798239, 0.54145268, 1],
      //   终身险到终龄后（t=5）无存续保单，准备金收敛回 0
      reservesWholeLife: [
        0,
        0.15198265,
        0.28345338,
        0.45480149,
        0.61057249,
        0,
      ],
    },
  },
  {
    id: 'zero-segment-40',
    description:
      '零死亡率段示范表（40 岁起）：前三年死亡率全为 0，用于验证定期死亡给付为 0、纯生存退化为纯贴现',
    startAge: 40,
    interestRate: 0.25,
    mortalityRates: [0, 0, 0, 0.5, 1],
    suggestedYears: 3,
    suggestedSumInsured: 100000,
    // 手算参考值：
    handCheck: {
      survival: [1, 1, 1, 1, 0.5],
      term3: 0, // 零死亡率段内没有死亡给付
      pureEndowment3: 0.512, // 退化为纯贴现 v^3 = 0.8^3
      endowment3: 0.512,
      // 零死亡段两全：保费年金 ä_{x:3} = 1 + 0.8 + 0.64 = 2.44，
      // P = 0.512 / 2.44；准备金即保费按 v=0.8 纯贴现/利息滚动的结果
      temporaryAnnuity3: 2.44,
      premiumEndowment3: 0.20983607,
      reservesEndowment3: [0, 0.26229508, 0.59016393, 1],
    },
  },
];

export function getSampleTable(id) {
  return SAMPLE_TABLES.find((t) => t.id === id) || null;
}
