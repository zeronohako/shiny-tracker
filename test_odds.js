// node test_odds.js
const { oddsText, binomialPct, remainingTo90 } = require('./odds.js');
const S = (o) => Object.assign({ generation: 9, shiny_charm: false, encounters: 0, encounter_method: 'random', sandwich: 0, outbreak: 0 }, o);
const eq = (a, b, msg) => { if (a !== b) throw new Error(msg + ': got ' + a + ', want ' + b); };

eq(oddsText(S({ generation: 2 })), '1/8192', 'gen2 base');
eq(oddsText(S({ generation: 6 })), '1/4096', 'gen6 base');
eq(oddsText(S({ generation: 7, shiny_charm: true })), '1/1366', 'gen7 charm');
eq(oddsText(S({ generation: 5, encounter_method: 'masuda', shiny_charm: true })), '1/1024', 'gen5 masuda charm');
eq(oddsText(S({ generation: 4, encounter_method: 'radar', encounters: 40 })), '1/200', 'gen4 radar 40 chain');
eq(oddsText(S({ generation: 8, encounters: 500 })), '1/683', 'gen8 500 battled');
eq(oddsText(S({ generation: 8, encounters: 500, shiny_charm: true })), '1/512', 'gen8 500 battled charm');
eq(oddsText(S({})), '1/4096', 'gen9 base');
eq(oddsText(S({ shiny_charm: true })), '1/1366', 'gen9 charm');
eq(oddsText(S({ sandwich: 3 })), '1/1024', 'gen9 lvl3 sandwich');
eq(oddsText(S({ sandwich: 3, outbreak: 2, shiny_charm: true })), '1/512', 'gen9 max rolls');
eq(oddsText(S({ encounter_method: 'masuda', shiny_charm: true })), '1/512', 'gen9 masuda charm');
eq(Math.round(binomialPct(S({ encounters: 4096 }))), 63, 'binomial ~63% at 1/p tries');
eq(remainingTo90(S({ encounters: 0 })), 9431, 'until 90% at 1/4096');
console.log('ok');
