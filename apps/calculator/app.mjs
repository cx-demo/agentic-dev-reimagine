export class Calculator {
  constructor() {
    this.clear();
  }

  clear() {
    this.display = "0";
    this.expression = "";
    this.firstOperand = null;
    this.operator = null;
    this.waitingForSecond = false;
    this.justEvaluated = false;
    this.error = false;
  }

  digit(value) {
    if (this.error || this.justEvaluated) this.clear();
    if (this.waitingForSecond) {
      this.display = value;
      this.waitingForSecond = false;
    } else if (this.display === "-0") {
      this.display = `-${value}`;
    } else {
      this.display = this.display === "0" ? value : this.display + value;
    }
  }

  decimal() {
    if (this.error || this.justEvaluated) this.clear();
    if (this.waitingForSecond) {
      this.display = "0.";
      this.waitingForSecond = false;
    } else if (!this.display.includes(".")) {
      this.display += ".";
    }
  }

  changeSign() {
    if (this.error) return;
    if (this.waitingForSecond) {
      this.display = "-0";
      this.waitingForSecond = false;
      return;
    }
    if (this.display !== "0") {
      this.display = this.display.startsWith("-") ? this.display.slice(1) : `-${this.display}`;
    }
  }

  backspace() {
    if (this.error) return this.clear();
    if (this.waitingForSecond || this.justEvaluated) return;
    this.display = this.display.length > 1 ? this.display.slice(0, -1) : "0";
    if (this.display === "-") this.display = "0";
  }

  percent() {
    if (this.error) return;
    const value = Number(this.display);
    if (!Number.isFinite(value)) return this.setError();
    this.display = formatNumber(value / 100);
    this.justEvaluated = false;
  }

  chooseOperator(operator) {
    if (this.error) return;
    if (this.operator && !this.waitingForSecond) return;
    const value = Number(this.display);
    if (!Number.isFinite(value)) return this.setError();
    this.firstOperand = value;
    this.operator = operator;
    this.waitingForSecond = true;
    this.justEvaluated = false;
    this.expression = `${formatNumber(value)} ${operator}`;
  }

  equals() {
    if (this.error || !this.operator || this.waitingForSecond) return;
    const secondOperand = Number(this.display);
    if (!Number.isFinite(secondOperand)) return this.setError();
    const result = this.operator === "+"
      ? this.firstOperand + secondOperand
      : this.firstOperand - secondOperand;
    if (!Number.isFinite(result)) return this.setError();
    this.expression = `${formatNumber(this.firstOperand)} ${this.operator} ${formatNumber(secondOperand)} =`;
    this.display = formatNumber(result);
    this.operator = null;
    this.firstOperand = null;
    this.justEvaluated = true;
  }

  setError() {
    this.display = "Error";
    this.expression = "Press C to clear";
    this.error = true;
  }
}

function formatNumber(value) {
  const normalized = Number(value.toPrecision(12));
  return Object.is(normalized, -0) ? "0" : String(normalized);
}

const keyActions = {
  "+": ["operator", "+"], "-": ["operator", "-"], ".": ["decimal"],
  "%": ["percent"], Enter: ["equals"], "=": ["equals"], Escape: ["clear"], Backspace: ["backspace"],
  c: ["clear"], C: ["clear"],
};

if (typeof document !== "undefined") {
  const calculator = new Calculator();
  const result = document.querySelector("#result");
  const expression = document.querySelector("#expression");

  function render() {
    result.textContent = calculator.display;
    expression.textContent = calculator.expression || "\u00a0";
  }

  function perform(action, value) {
    if (action === "digit") calculator.digit(value);
    else if (action === "operator") calculator.chooseOperator(value);
    else if (action === "decimal") calculator.decimal();
    else if (action === "sign") calculator.changeSign();
    else if (action === "percent") calculator.percent();
    else if (action === "backspace") calculator.backspace();
    else if (action === "equals") calculator.equals();
    else if (action === "clear") calculator.clear();
    render();
  }

  document.querySelector(".keys").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) perform(button.dataset.action, button.dataset.value);
  });

  document.addEventListener("keydown", (event) => {
    const action = /^[0-9]$/.test(event.key) ? ["digit", event.key] : keyActions[event.key];
    if (action) {
      event.preventDefault();
      perform(...action);
    }
  });

  render();
}
