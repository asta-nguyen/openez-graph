const { nsFn: topNs } = require("./mod.cjs");

function handler() {
  const { nsFn } = require("./mod.cjs");
  nsFn();
}

function writer() {
  const mod = require("./mod.cjs");
  mod.nsFn();
}

function scopedInner() {
  {
    const { prop } = require("./mod.cjs");
    prop();
  }
}

function outsideScope() {
  // `prop` is bound only inside scopedInner's inner block — no edge.
  prop();
}

function varScoped() {
  // `var` require binding is function-scoped — visible outside the block.
  {
    var io2 = require("./mod.cjs");
  }
  io2.nsFn();
}

function sw() {
  // The discriminant is evaluated outside the case-block scope — `topNs`
  // declared in case 1 must not shadow this call.
  switch (topNs()) {
    case 1:
      const topNs = 0;
      break;
  }
}

function swRequire() {
  // Case-local require binds `topNs` only inside the case — the discriminant
  // still uses the module-scope binding (mod.cjs), not objmod.cjs.
  switch (topNs()) {
    case 1:
      const { objFn: topNs } = require("./objmod.cjs");
      topNs();
  }
}
