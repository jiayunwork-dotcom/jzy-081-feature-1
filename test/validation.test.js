// 参数校验测试：非法生命表与参数必须在任何计算之前被挡下，错误结构化。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLifeTableInput,
  validateEndowmentInput,
  validatePolicyInput,
} from '../src/validation/validate.js';
import { ValidationError } from '../src/errors.js';

const goodBody = {
  startAge: 40,
  mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
  interestRate: 0.05,
};

function expectValidation(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 400);
    assert.ok(Array.isArray(err.issues) && err.issues.length > 0);
    assert.ok(err.issues.every((x) => x.field && x.code && x.detail));
    return true;
  });
}

test('合法入参通过校验并返回清洗结果', () => {
  const r = validateLifeTableInput(goodBody);
  assert.equal(r.startAge, 40);
  assert.equal(r.interestRate, 0.05);
  assert.deepEqual(r.qx, goodBody.mortalityRates);
});

test('年龄越界被挡（负数 / 超上限 / 非整数 / 缺失）', () => {
  expectValidation(() => validateLifeTableInput({ ...goodBody, startAge: -1 }));
  expectValidation(() => validateLifeTableInput({ ...goodBody, startAge: 121 }));
  expectValidation(() => validateLifeTableInput({ ...goodBody, startAge: 40.5 }));
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, startAge: undefined }));
});

test('生命表超龄（startAge + 长度 - 1 > 120）被挡', () => {
  const qx = new Array(82).fill(0);
  qx[81] = 1; // 40 + 82 - 1 = 121
  expectValidation(() =>
    validateLifeTableInput({ startAge: 40, mortalityRates: qx, interestRate: 0.05 }));
});

test('死亡率落到 [0,1] 之外被挡', () => {
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: [0.1, 1.2, 1] }));
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: [-0.01, 0.5, 1] }));
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: [0.1, NaN, 1] }));
});

test('终龄死亡率不为 1 被挡', () => {
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: [0.1, 0.2, 0.9] }));
});

test('死亡率序列为空 / 非数组被挡', () => {
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: [] }));
  expectValidation(() =>
    validateLifeTableInput({ ...goodBody, mortalityRates: null }));
});

test('利率低到贴现因子非正（i <= -1）被挡', () => {
  expectValidation(() => validateLifeTableInput({ ...goodBody, interestRate: -1 }));
  expectValidation(() => validateLifeTableInput({ ...goodBody, interestRate: -1.5 }));
});

test('保额非正被挡（0 / 负数 / NaN）', () => {
  const mk = (sumInsured) =>
    () =>
      validateEndowmentInput({
        ...goodBody,
        years: 3,
        sumInsured,
      });
  expectValidation(mk(0));
  expectValidation(mk(-100));
  expectValidation(mk(NaN));
});

test('保障年限非法被挡（负数 / 非整数 / 超过表长），n=0 合法', () => {
  const mk = (years) =>
    () =>
      validateEndowmentInput({
        ...goodBody,
        years,
        sumInsured: 1000,
      });
  expectValidation(mk(-1));
  expectValidation(mk(2.5));
  expectValidation(mk(99));
  assert.doesNotThrow(mk(0));
  assert.doesNotThrow(mk(goodBody.mortalityRates.length));
});

test('多个问题一次性收集到多条 issue', () => {
  try {
    validateEndowmentInput({
      startAge: -5,
      mortalityRates: [2, -1],
      interestRate: -2,
      years: -3,
      sumInsured: 0,
    });
    assert.fail('应当抛出 ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    const fields = new Set(err.issues.map((x) => x.field));
    assert.ok(fields.has('startAge'));
    assert.ok(fields.has('mortalityRates'));
    assert.ok(fields.has('interestRate'));
    assert.ok(fields.has('years'));
    assert.ok(fields.has('sumInsured'));
  }
});

// ---- 保单核算接口（productType / years / sumInsured）----

const goodPolicy = {
  startAge: 40,
  mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
  interestRate: 0.05,
  sumInsured: 100000,
  productType: 'endowment',
  years: 3,
};

test('保单接口：合法入参通过并清洗出 product 结构', () => {
  const en = validatePolicyInput(goodPolicy);
  assert.deepEqual(en.product, { type: 'endowment', years: 3 });
  const wl = validatePolicyInput({ ...goodPolicy, productType: 'wholeLife', years: undefined });
  assert.deepEqual(wl.product, { type: 'wholeLife' });
});

test('保单接口：产品形态非法或缺失被挡', () => {
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: 'term' }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: undefined }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, productType: 3 }));
});

test('保单接口：两全年限缺失 / 为 0 / 为负 / 非整数 / 超表长被挡', () => {
  const mk = (years) => () => validatePolicyInput({ ...goodPolicy, years });
  expectValidation(mk(undefined));
  expectValidation(mk(0)); // 趸缴口径允许 n=0，年缴保费口径不允许
  expectValidation(mk(-2));
  expectValidation(mk(2.5));
  expectValidation(mk(99));
  assert.doesNotThrow(mk(1));
  assert.doesNotThrow(mk(goodPolicy.mortalityRates.length)); // 满表长合法
});

test('保单接口：终身险不强制年限（多给的 years 被忽略）', () => {
  assert.doesNotThrow(() => validatePolicyInput({
    ...goodPolicy, productType: 'wholeLife', years: undefined,
  }));
  const r = validatePolicyInput({ ...goodPolicy, productType: 'wholeLife', years: 2 });
  assert.deepEqual(r.product, { type: 'wholeLife' });
});

test('保单接口：沿用趸缴口径的全部基础校验（年龄/死亡率/利率/保额）', () => {
  expectValidation(() => validatePolicyInput({ ...goodPolicy, startAge: 130 }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, mortalityRates: [0.5, 0.9] }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, interestRate: -1 }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, sumInsured: 0 }));
  expectValidation(() => validatePolicyInput({ ...goodPolicy, sumInsured: -5 }));
});

test('保单接口：多个问题一次性收集（含 productType 与 years）', () => {
  try {
    validatePolicyInput({
      startAge: 40,
      mortalityRates: [0.1, 0.2, 0.25, 0.5, 1],
      interestRate: 0.05,
      sumInsured: -1,
      productType: 'endowment',
      years: 0,
    });
    assert.fail('应当抛出 ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    const fields = new Set(err.issues.map((x) => x.field));
    assert.ok(fields.has('sumInsured'));
    assert.ok(fields.has('years'));
  }
});
