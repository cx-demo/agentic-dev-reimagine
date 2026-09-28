# Desk Calculator

Open `index.html` in a modern browser, or serve this directory with:

```sh
python3 -m http.server --directory apps/calculator
```

The calculator supports one addition or subtraction at a time, ordinary decimal
numbers, sign change, and percent. Percent converts the displayed value to a
fraction: `200 - 25%` displays `199.75`.

When used immediately after an operator, percent seeds the second operand from
the displayed first operand (`5 + %` displays `5.05` after `=`). A second
operator is ignored after entering the second operand; press `=` to complete
the current pair before starting another.

Keyboard controls: digits, `+`, `-`, `.`, `%`, Enter or `=`, Escape, Backspace,
and `c` (case-insensitive) for clear.

Run the focused tests with:

```sh
node --test apps/calculator/test/app.test.mjs
```
