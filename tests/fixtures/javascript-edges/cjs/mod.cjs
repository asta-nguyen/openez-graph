function localFn() {
  return "local";
}

exports.nsFn = function () {
  return localFn();
};

module.exports.prop = localFn;

function pump() {
  exports.nsFn();
  module.exports.prop();
}
