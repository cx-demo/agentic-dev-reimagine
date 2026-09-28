import assert from "node:assert/strict";
import test from "node:test";
import { Calculator } from "../app.mjs";

function press(calculator, ...keys) {
  for (const key of keys) {
    if (/^\d$/.test(key)) calculator.digit(key);
    else if (key === ".") calculator.decimal();
    else if (key === "+" || key === "-") calculator.chooseOperator(key);
    else if (key === "=") calculator.equals();
    else if (key === "±") calculator.changeSign();
    else if (key === "%") calculator.percent();
  }
}

test("adds two decimal operands", () => {
  const calculator = new Calculator();
  press(calculator, "1", ".", "5", "+", "2", ".", "5", "=");
  assert.equal(calculator.display, "4");
  assert.equal(calculator.expression, "1.5 + 2.5 =");
});

test("subtracts and supports signed operands", () => {
  const calculator = new Calculator();
  press(calculator, "5", "±", "-", "8", "=");
  assert.equal(calculator.display, "-13");
});

test("starts a negative second operand with sign change", () => {
  const calculator = new Calculator();
  press(calculator, "5", "+", "±", "3", "=");
  assert.equal(calculator.display, "2");
});

test("keeps a sign-adjusted result editable", () => {
  const calculator = new Calculator();
  press(calculator, "5", "+", "5", "=", "±");
  calculator.digit("2");
  assert.equal(calculator.display, "-102");
});

test("normalizes ordinary decimal results", () => {
  const calculator = new Calculator();
  press(calculator, "0", ".", "1", "+", "0", ".", "2", "=");
  assert.equal(calculator.display, "0.3");
});

test("removes an entered digit with backspace", () => {
  const calculator = new Calculator();
  press(calculator, "1", "2");
  calculator.backspace();
  assert.equal(calculator.display, "1");
});

test("replaces an operator until a second operand is entered", () => {
  const calculator = new Calculator();
  press(calculator, "7", "+", "-", "2", "=");
  assert.equal(calculator.display, "5");
  assert.equal(calculator.expression, "7 - 2 =");
});

test("requires equals before another operation can begin", () => {
  const calculator = new Calculator();
  press(calculator, "7", "+", "2", "-");
  assert.equal(calculator.expression, "7 +");
  press(calculator, "=");
  assert.equal(calculator.display, "9");
});

test("converts the displayed operand to a fraction with percent", () => {
  const calculator = new Calculator();
  press(calculator, "2", "0", "0", "-", "2", "5", "%", "=");
  assert.equal(calculator.display, "199.75");
});

test("makes percent the second operand after an operator", () => {
  const calculator = new Calculator();
  press(calculator, "5", "+", "%", "=");
  assert.equal(calculator.display, "5.05");
});

test("does not reuse an operand when equals is pressed without a second value", () => {
  const calculator = new Calculator();
  press(calculator, "7", "+", "=");
  assert.equal(calculator.display, "7");
  assert.equal(calculator.expression, "7 +");
});

test("starts a new one-pair calculation from a result when an operator is selected", () => {
  const calculator = new Calculator();
  press(calculator, "5", "+", "5", "=", "-", "3", "=");
  assert.equal(calculator.display, "7");
  assert.equal(calculator.expression, "10 - 3 =");
});

test("converts a result to a percentage", () => {
  const calculator = new Calculator();
  press(calculator, "5", "+", "5", "=", "%");
  assert.equal(calculator.display, "0.1");
  calculator.digit("1");
  assert.equal(calculator.display, "0.11");
});

test("keeps overflow errors recoverable", () => {
  const calculator = new Calculator();
  calculator.clear();
  for (let index = 0; index < 400; index += 1) calculator.digit("9");
  calculator.chooseOperator("+");
  assert.equal(calculator.display, "Error");
  calculator.clear();
  assert.equal(calculator.display, "0");
});
