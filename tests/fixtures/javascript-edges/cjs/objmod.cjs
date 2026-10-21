function localFn() {
  return "obj";
}

module.exports = {
  objFn: function () {
    return localFn();
  },
  named: localFn,
};
