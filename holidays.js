/* South African public holidays (Public Holidays Act 36 of 1994): a holiday on a Sunday moves to the Monday. */
(function () {
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  var cache = {};
  function holidays(y) {
    if (cache[y]) return cache[y];
    var set = {};
    ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'].forEach(function (md) {
      var d = new Date(y + '-' + md + 'T00:00:00Z');
      set[iso(d)] = 1;
      if (d.getUTCDay() === 0) set[iso(new Date(d.getTime() + 86400000))] = 1;
    });
    var e = easter(y);
    set[iso(new Date(e.getTime() - 2 * 86400000))] = 1; // Good Friday
    set[iso(new Date(e.getTime() + 86400000))] = 1; // Family Day
    return (cache[y] = set);
  }
  /** Working days (Monday to Friday, not a public holiday) from a to b inclusive, both 'YYYY-MM-DD'. */
  window.kpWorkingDays = function (a, b) {
    var d = new Date(a + 'T00:00:00Z'), end = new Date(b + 'T00:00:00Z'), n = 0, guard = 0;
    if (isNaN(d) || isNaN(end)) return 0;
    while (d <= end && guard++ < 800) {
      var wd = d.getUTCDay(), s = iso(d);
      if (wd !== 0 && wd !== 6 && !holidays(d.getUTCFullYear())[s]) n++;
      d = new Date(d.getTime() + 86400000);
    }
    return n;
  };
  window.kpIsHoliday = function (s) { return !!holidays(+s.slice(0, 4))[s]; };
})();
