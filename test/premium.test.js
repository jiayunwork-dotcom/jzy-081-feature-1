// 均衡年缴净保费测试：等价原则配平、手算基准值、缴费期口径、零死亡率退化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { survivalProbabilities } from '../src/actuarial/survival.js';
import { wholeLifeInsuranceAPV } from '../src/actuarial/wholeLife.js';
import {
  annuityDueAPV,
  temporaryAnnuityDueAPV,
} from '../src/actuarial/annuity.js';
import { endowmentInsuranceAPV } from '../src/actuarial/endowment.js';
import { levelNetPremium } from '../src/actuarial/premium.js';

const EPS = 1e-10;

// 标准示范表（40 岁起，i=25%，v=0.8，d=0.2）
const STD = { qx: [0.1, 0.2, 0.25, 0.5, 1], i: 0.25 };
// 零死亡率段表：前三年 q=0
const ZERO = { qx: [0, 0, 0, 0.5, 1], i: 0.25 };

test('限期期初年金：前 n 个年初的 v^k·_k p_x 之和，n=0 为 0', () => {
  const s = survivalProbabilities(STD.qx);
  // ä_{40:3} = 1 + 0.8·0.9 + 0.64·0.72 = 2.1808
  assert.ok(Math.abs(temporaryAnnuityDueAPV(s, STD.i, 3) - 2.1808) < EPS);
  assert.equal(temporaryAnnuityDueAPV(s, STD.i, 0), 0);
  // n 取满表长时与全期年金一致（终龄 q=1，之后无生存者）
  assert.ok(
    Math.abs(
      temporaryAnnuityDueAPV(s, STD.i, STD.qx.length) - annuityDueAPV(s, STD.i),
    ) < EPS,
  );
});

test('终身寿险均衡保费手算值：P = A_x / ä_x（标准表）', () => {
  const p = levelNetPremium({
    qx: STD.qx, interestRate: STD.i, product: { type: 'wholeLife' },
  });
  // P = 0.4864256 / 2.567872 = 0.18942751...
  assert.ok(Math.abs(p.perUnit - 0.4864256 / 2.567872) < EPS);
  assert.ok(Math.abs(p.perUnit - 0.1894275) < 1e-6);
  assert.equal(p.premiumYears, STD.qx.length); // 保费缴到终龄
  assert.equal(p.coverageYears, STD.qx.length);
});

test('两全均衡保费手算值：P = A_{x:n} / ä_{x:n}（标准表 n=3）', () => {
  const p = levelNetPremium({
    qx: STD.qx, interestRate: STD.i, product: { type: 'endowment', years: 3 },
  });
  // P = 0.56384 / 2.1808 = 0.25854732...
  assert.ok(Math.abs(p.perUnit - 0.56384 / 2.1808) < EPS);
  assert.ok(Math.abs(p.perUnit - 0.2585473) < 1e-6);
  assert.equal(p.premiumYears, 3); // 保费缴到保障年限满
  assert.equal(p.coverageYears, 3);
});

test('等价原则配平：P·ä 与给付现值之差为零（两种产品、多档利率）', () => {
  for (const i of [0, 0.03, 0.25, 0.6]) {
    const s = survivalProbabilities(STD.qx);
    const wl = levelNetPremium({
      qx: STD.qx, interestRate: i, product: { type: 'wholeLife' },
    });
    const A = wholeLifeInsuranceAPV(s, i);
    const ann = annuityDueAPV(s, i);
    assert.ok(
      Math.abs(wl.perUnit * ann - A) < EPS,
      `终身险未配平 @i=${i}`,
    );

    const en = levelNetPremium({
      qx: STD.qx, interestRate: i, product: { type: 'endowment', years: 3 },
    });
    const benefit = endowmentInsuranceAPV(s, i, 3).endowment;
    const tempAnn = temporaryAnnuityDueAPV(s, i, 3);
    assert.ok(
      Math.abs(en.perUnit * tempAnn - benefit) < EPS,
      `两全未配平 @i=${i}`,
    );
  }
});

test('零死亡率段：两全保费 = 纯贴现 / 纯贴现年金，准备金路径可预期', () => {
  const p = levelNetPremium({
    qx: ZERO.qx, interestRate: ZERO.i, product: { type: 'endowment', years: 3 },
  });
  // 给付现值 = v^3 = 0.512，保费年金 = 1 + 0.8 + 0.64 = 2.44
  assert.ok(Math.abs(p.perUnit - 0.512 / 2.44) < EPS);
  assert.ok(Math.abs(p.perUnit - 0.2098361) < 1e-6);
});

test('退化情形：两全年限取满表长时，保费退化为终身寿险保费', () => {
  const wl = levelNetPremium({
    qx: STD.qx, interestRate: STD.i, product: { type: 'wholeLife' },
  });
  const deg = levelNetPremium({
    qx: STD.qx,
    interestRate: STD.i,
    product: { type: 'endowment', years: STD.qx.length },
  });
  // 终龄 q=1：纯生存现值为 0、限期年金 = 全期年金，两者口径合一
  assert.ok(Math.abs(deg.perUnit - wl.perUnit) < EPS);
});

test('利率抬高：均衡保费下降（给付远年化，贴现更重）', () => {
  const premiums = [0, 0.05, 0.25, 0.6].map(
    (i) => levelNetPremium({
      qx: STD.qx, interestRate: i, product: { type: 'wholeLife' },
    }).perUnit,
  );
  for (let k = 1; k < premiums.length; k++) {
    assert.ok(premiums[k] < premiums[k - 1], `保费未随利率下降: ${premiums}`);
  }
});
