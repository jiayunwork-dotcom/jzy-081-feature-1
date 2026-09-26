// 逐年净准备金测试：往后看/回算双口径、递推关系、签单为零、满期收敛。
import test from 'node:test';
import assert from 'node:assert/strict';

import { levelNetPremium } from '../src/actuarial/premium.js';
import {
  prospectiveReserveAt,
  prospectiveReserveSchedule,
} from '../src/actuarial/reserve.js';
import { retrospectiveReserveSchedule } from '../src/actuarial/retrospective.js';
import { recursionResiduals } from '../src/actuarial/recursion.js';
import { valuePolicy } from '../src/actuarial/policy.js';

const EPS = 1e-10;

// 标准示范表（40 岁起，i=25%，v=0.8，d=0.2）
const STD = { qx: [0.1, 0.2, 0.25, 0.5, 1], i: 0.25 };
const WL_PRODUCT = { type: 'wholeLife' };
const EN3_PRODUCT = { type: 'endowment', years: 3 };

const premiumOf = (product, qx = STD.qx, i = STD.i) =>
  levelNetPremium({ qx, interestRate: i, product }).perUnit;

test('签单时点准备金为零（等价原则直接后果，两种产品）', () => {
  for (const product of [WL_PRODUCT, EN3_PRODUCT]) {
    const v0 = prospectiveReserveAt({
      qx: STD.qx,
      interestRate: STD.i,
      product,
      premiumPerUnit: premiumOf(product),
      t: 0,
    });
    assert.ok(Math.abs(v0) < EPS, `V_0 = ${v0}`);
  }
});

test('终身险逐年准备金手算值（标准表，单位保额）', () => {
  const P = premiumOf(WL_PRODUCT); // 0.18942751...
  const schedule = prospectiveReserveSchedule({
    qx: STD.qx, interestRate: STD.i, product: WL_PRODUCT, premiumPerUnit: P,
  });
  assert.equal(schedule.length, STD.qx.length); // 排到终龄
  // 各年以 x+t 为新起点重切表后的 A、ä 手算值：
  //   t=1: A=0.56448, ä=2.1776   t=2: A=0.632, ä=1.84
  //   t=3: A=0.72,   ä=1.4       t=4: A=0.8,   ä=1
  const expected = [
    0.56448 - P * 2.1776,
    0.632 - P * 1.84,
    0.72 - P * 1.4,
    0.8 - P * 1,
    0, // 终龄之后：全部给付了结，准备金收敛到 0
  ];
  schedule.forEach((v, t) => {
    assert.ok(Math.abs(v - expected[t]) < EPS, `t=${t + 1}: ${v} != ${expected[t]}`);
  });
  // 与手算常数对照（7 位有效数字）
  assert.ok(Math.abs(schedule[0] - 0.1519827) < 1e-6);
  assert.ok(Math.abs(schedule[3] - 0.6105725) < 1e-6);
});

test('两全逐年准备金手算值：满期前收敛到保额（标准表 n=3）', () => {
  const P = premiumOf(EN3_PRODUCT); // 0.25854732...
  const schedule = prospectiveReserveSchedule({
    qx: STD.qx, interestRate: STD.i, product: EN3_PRODUCT, premiumPerUnit: P,
  });
  assert.equal(schedule.length, 3); // 排到满期
  // t=1: 剩余 2 年，A_{41:2}=0.672, ä_{41:2}=1.64
  assert.ok(Math.abs(schedule[0] - (0.672 - P * 1.64)) < EPS);
  assert.ok(Math.abs(schedule[0] - 0.2479824) < 1e-6);
  // t=2: 剩余 1 年，A_{42:1}=0.8, ä_{42:1}=1
  assert.ok(Math.abs(schedule[1] - (0.8 - P)) < EPS);
  assert.ok(Math.abs(schedule[1] - 0.5414527) < 1e-6);
  // t=3: 满期那一刻、给付纯生存金之前，准备金刚好等于保额（单位 1）
  assert.ok(Math.abs(schedule[2] - 1) < EPS);
});

test('递推关系逐年闭合：(V_t + P)(1+i) = q_{x+t}·S + p_{x+t}·V_{t+1}', () => {
  const S = 100000;
  for (const product of [WL_PRODUCT, EN3_PRODUCT]) {
    const P = premiumOf(product) * S;
    const reserves = prospectiveReserveSchedule({
      qx: STD.qx,
      interestRate: STD.i,
      product,
      premiumPerUnit: P / S,
    }).map((v) => v * S);
    const residuals = recursionResiduals({
      qx: STD.qx, interestRate: STD.i, premium: P, sumInsured: S, reserves,
    });
    assert.equal(residuals.length, reserves.length);
    residuals.forEach((r, t) => {
      assert.ok(
        Math.abs(r) < 1e-9 * S,
        `${product.type} 第 ${t}→${t + 1} 步递推残差 ${r}`,
      );
    });
  }
});

test('递推模块能检出被篡改的准备金序列', () => {
  const S = 1000;
  const P = premiumOf(EN3_PRODUCT) * S;
  const reserves = prospectiveReserveSchedule({
    qx: STD.qx, interestRate: STD.i, product: EN3_PRODUCT, premiumPerUnit: P / S,
  }).map((v) => v * S);
  reserves[1] += 50; // 人为破坏第 2 年末准备金
  const residuals = recursionResiduals({
    qx: STD.qx, interestRate: STD.i, premium: P, sumInsured: S, reserves,
  });
  // 第 1→2 步（带大准备金）与第 2→3 步（基数被抬高）都应出现可观残差
  assert.ok(Math.abs(residuals[1]) > 1);
  assert.ok(Math.abs(residuals[2]) > 1);
});

test('回算口径与往后看口径逐年对得上（两种产品）', () => {
  for (const product of [WL_PRODUCT, EN3_PRODUCT]) {
    const P = premiumOf(product);
    const term = product.type === 'wholeLife' ? STD.qx.length : product.years;
    const prospective = prospectiveReserveSchedule({
      qx: STD.qx, interestRate: STD.i, product, premiumPerUnit: P,
    });
    const retrospective = retrospectiveReserveSchedule({
      qx: STD.qx, interestRate: STD.i, premiumPerUnit: P, term,
    });
    prospective.forEach((v, idx) => {
      const retro = retrospective[idx] === null ? v : retrospective[idx];
      assert.ok(
        Math.abs(v - retro) < EPS,
        `${product.type} 第 ${idx + 1} 年：往后看 ${v} vs 回算 ${retro}`,
      );
    });
  }
});

test('回算口径手算值：已收保费积累 − 已发生给付积累，按生存者分摊', () => {
  const P = premiumOf(EN3_PRODUCT);
  const retro = retrospectiveReserveSchedule({
    qx: STD.qx, interestRate: STD.i, premiumPerUnit: P, term: 3,
  });
  // _1V = (P·1 − 0.08) / 0.72；_2V = (P·1.72 − 0.1952) / 0.4608；_3V = 1
  assert.ok(Math.abs(retro[0] - (P - 0.08) / 0.72) < EPS);
  assert.ok(Math.abs(retro[1] - (P * 1.72 - 0.1952) / 0.4608) < EPS);
  assert.ok(Math.abs(retro[2] - 1) < EPS);
  assert.ok(retro.every((v) => v !== null)); // 两全满期前每年都有生存者
});

test('终身险末年年末：生存者灭绝，回算口径无定义（null），由编排层补边界值', () => {
  const P = premiumOf(WL_PRODUCT);
  const retro = retrospectiveReserveSchedule({
    qx: STD.qx, interestRate: STD.i, premiumPerUnit: P, term: STD.qx.length,
  });
  // 终龄 q=1：_5 p = 0，最后一年回算为 0/0，模块如实返回 null
  assert.equal(retro[STD.qx.length - 1], null);
  assert.ok(retro.slice(0, -1).every((v) => v !== null));

  // 编排层以边界值补齐后，两条路径全序列一致
  const policy = valuePolicy({
    qx: STD.qx, interestRate: STD.i, sumInsured: 100000, product: WL_PRODUCT,
  });
  const last = policy.reserves[policy.reserves.length - 1];
  assert.equal(last.retrospectiveBoundaryFilled, true);
  assert.equal(last.prospective, 0);
  assert.equal(last.retrospective, 0);
  assert.equal(policy.checks.pathsAgree.passed, true);
});

test('valuePolicy 全部闭合检查通过（终身 / 两全 / 零死亡率段 / 退化两全）', () => {
  const cases = [
    { qx: STD.qx, i: STD.i, product: WL_PRODUCT, S: 100000 },
    { qx: STD.qx, i: STD.i, product: EN3_PRODUCT, S: 100000 },
    { qx: [0, 0, 0, 0.5, 1], i: STD.i, product: EN3_PRODUCT, S: 50000 },
    // 退化：两全年限 = 表长，保费与准备金应贴合终身险（除末点满期边界）
    { qx: STD.qx, i: STD.i, product: { type: 'endowment', years: 5 }, S: 8000 },
    // 最短表：单年必死
    { qx: [1], i: 0.05, product: WL_PRODUCT, S: 1000 },
    { qx: [0.4, 1], i: 0.1, product: { type: 'endowment', years: 1 }, S: 2000 },
  ];
  for (const { qx, i, product, S } of cases) {
    const r = valuePolicy({ qx, interestRate: i, sumInsured: S, product });
    for (const [name, check] of Object.entries(r.checks)) {
      assert.ok(check.passed, `${product.type} ${name} 未通过: ${JSON.stringify(check)}`);
    }
    // 序列长度 = 保障期数
    const term = product.type === 'wholeLife' ? qx.length : product.years;
    assert.equal(r.reserves.length, term);
    // 金额口径 = 单位口径 × 保额
    for (const entry of r.reserves) {
      assert.ok(Math.abs(entry.prospective - entry.perUnit.prospective * S) < 1e-6 * S);
    }
  }
});

test('零死亡率段两全：准备金逐年纯积累，满期爬到保额', () => {
  const r = valuePolicy({
    qx: [0, 0, 0, 0.5, 1],
    interestRate: STD.i,
    sumInsured: 1,
    product: EN3_PRODUCT,
  });
  const expected = [0.2622951, 0.5901639, 1]; // 手算参考值
  r.reserves.forEach((entry, idx) => {
    assert.ok(Math.abs(entry.perUnit.prospective - expected[idx]) < 1e-6);
  });
});

test('准备金随保额同比例放大（单位口径不变）', () => {
  const base = valuePolicy({
    qx: STD.qx, interestRate: STD.i, sumInsured: 1, product: EN3_PRODUCT,
  });
  const scaled = valuePolicy({
    qx: STD.qx, interestRate: STD.i, sumInsured: 250000, product: EN3_PRODUCT,
  });
  assert.equal(scaled.netPremium.perUnit, base.netPremium.perUnit);
  base.reserves.forEach((entry, idx) => {
    assert.ok(
      Math.abs(
        scaled.reserves[idx].prospective - entry.prospective * 250000,
      ) < 1e-6 * 250000,
    );
  });
});
