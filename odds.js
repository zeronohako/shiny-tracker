// Shiny odds math. Returns the denominator N of a 1/N chance.
// Ported from shinytrack.night.coffee, extended with Gen 9 (Scarlet/Violet).
function oddsDenominator(s) {
  var gen = s.generation, charm = s.shiny_charm, n = s.encounters, m = s.encounter_method;
  var d = gen >= 6 ? 4096 : 8192;
  if (charm && gen === 5) d = 2731;
  if (charm && gen >= 6) d = 1365.333;

  if (m === 'masuda') {
    if (gen === 4) d = 1638;
    if (gen === 5) d = charm ? 1024 : 1365;
    if (gen >= 6) d = charm ? 512 : 683;
  }
  if (m === 'safari' || m === 'dex_nav') d = 512;
  if (m === 'radar' || m === 'fishing') {
    var b = Math.min(Math.max(n, 0), 40);
    d = Math.ceil(65536 / Math.ceil(65535 / (8200 - 200 * b)));
    if (gen === 6) d /= 2;
    if (charm) d = Math.ceil(d / 3);
  }
  if (m === 'sos' && n % 256 >= 70) d = charm ? 683 : 1024;
  if (m === 'random' && gen === 8) {
    // Number Battled bonus tiers
    var tier = n >= 500 ? 5 : n >= 300 ? 4 : n >= 200 ? 3 : n >= 100 ? 2 : n >= 50 ? 1 : 0;
    d = [4096, 2048, 1365.333, 1024, 819.2, 682.6667][tier];
    if (charm) d = [1365.333, 1024, 819.2, 682.6667, 585.1429, 512][tier];
  }
  if (gen === 9 && m !== 'masuda') {
    // Each bonus adds extra rolls: charm +2, Sparkling Power lvl 1/2/3 +1/+2/+3, outbreak 30/60 KOs +1/+2
    var rolls = 1 + (charm ? 2 : 0) + (s.sandwich || 0) + (s.outbreak || 0);
    d = 4096 / rolls;
  }
  return d;
}

function odds(s) { return 1 / Math.ceil(oddsDenominator(s)); }
function oddsText(s) { return '1/' + Math.ceil(oddsDenominator(s)); }
// Chance (%) of having found at least one shiny in `encounters` tries
function binomialPct(s) { return 100 * (1 - Math.pow(1 - odds(s), s.encounters)); }
// Encounters left until that chance reaches 90%
function remainingTo90(s) { return Math.ceil(Math.log(0.1) / Math.log(1 - odds(s))) - s.encounters; }

if (typeof module !== 'undefined') module.exports = { oddsDenominator: oddsDenominator, oddsText: oddsText, binomialPct: binomialPct, remainingTo90: remainingTo90 };
