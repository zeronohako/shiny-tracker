var $ = function (id) { return document.getElementById(id); };
var SPRITES = 'https://play.pokemonshowdown.com/sprites/';
var DEFAULTS = { generation: 9, shiny_charm: false, encounters: 0, encounter_method: 'random',
  sandwich: 0, outbreak: 0, target: '', start_date: new Date().toISOString(), show_stats: true, dark_theme: false };

var settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('settings') || '{}'));

function save() { localStorage.setItem('settings', JSON.stringify(settings)); render(); }

function timeAgo(iso) {
  var s = (Date.now() - new Date(iso)) / 1000;
  if (!(s >= 0)) return 'just now';
  var units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (var i = 0; i < units.length; i++) {
    var n = Math.floor(s / units[i][1]);
    if (n >= 1) return n + ' ' + units[i][0] + (n > 1 ? 's' : '') + ' ago';
  }
  return 'just now';
}

// ISO -> local "YYYY-MM-DDTHH:MM" for <input type=datetime-local>
function toLocalInput(iso) {
  var d = new Date(iso);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function setActive(groupId, attr, value) {
  var btns = $(groupId).querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset[attr] === String(value));
}

function render() {
  document.body.classList.toggle('dark', settings.dark_theme);
  // Track tab
  $('count').textContent = settings.encounters.toLocaleString();
  var id = POKEMON[settings.target];
  $('target-box').hidden = !id;
  if (id) {
    var img = $('target-img');
    img.alt = img.title = settings.target;
    img.onerror = function () { img.onerror = null; img.src = SPRITES + 'gen5-shiny/' + id + '.png'; };
    img.src = SPRITES + 'ani-shiny/' + id + '.gif';
  }
  $('stats').hidden = !settings.show_stats;
  $('stat-start').value = timeAgo(settings.start_date);
  $('stat-odds').value = oddsText(settings);
  $('stat-binom').value = binomialPct(settings).toFixed(2) + '%';
  $('stat-remaining').value = remainingTo90(settings).toLocaleString();
  // Setup tab
  setActive('gen-group', 'gen', settings.generation);
  $('charm-block').hidden = settings.generation < 5;
  setActive('charm-group', 'charm', settings.shiny_charm);
  $('method').value = settings.encounter_method;
  $('gen9-block').hidden = settings.generation !== 9;
  setActive('sandwich-group', 'sandwich', settings.sandwich);
  setActive('outbreak-group', 'outbreak', settings.outbreak);
  $('target').value = settings.target;
  $('start-date').value = toLocalInput(settings.start_date);
  setActive('stats-group', 'stats', settings.show_stats);
  setActive('theme-group', 'theme', settings.dark_theme);
}

function showTab() {
  var tab = location.hash.slice(1) || 'track';
  if (!$(tab) || !$(tab).classList.contains('panel')) tab = 'track';
  ['track', 'setup', 'about'].forEach(function (t) { $(t).hidden = t !== tab; });
  document.querySelectorAll('.tabs a').forEach(function (a) { a.classList.toggle('active', a.dataset.tab === tab); });
}

function bindGroup(groupId, attr, key, parse) {
  $(groupId).addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    settings[key] = parse(b.dataset[attr]); save();
  });
}
var toBool = function (v) { return v === 'true'; };

$('inc').onclick = function () { settings.encounters++; save(); };
$('dec').onclick = function () { if (settings.encounters > 0) settings.encounters--; save(); };
$('count').onclick = function () { $('edit-count').value = settings.encounters; $('edit-dialog').showModal(); $('edit-count').select(); };
$('edit-dialog').onclose = function () {
  if ($('edit-dialog').returnValue !== 'save') return;
  settings.encounters = Math.max(0, Math.floor(+$('edit-count').value) || 0); save();
};

bindGroup('gen-group', 'gen', 'generation', Number);
bindGroup('charm-group', 'charm', 'shiny_charm', toBool);
bindGroup('sandwich-group', 'sandwich', 'sandwich', Number);
bindGroup('outbreak-group', 'outbreak', 'outbreak', Number);
bindGroup('stats-group', 'stats', 'show_stats', toBool);
bindGroup('theme-group', 'theme', 'dark_theme', toBool);
$('method').onchange = function () { settings.encounter_method = this.value; save(); };
$('target').onchange = function () { settings.target = this.value.trim(); save(); };
$('start-date').onchange = function () { if (this.value) { settings.start_date = new Date(this.value).toISOString(); save(); } };
$('reset').onclick = function () {
  if (!confirm('Reset all settings and the encounter count?')) return;
  settings = Object.assign({}, DEFAULTS, { start_date: new Date().toISOString() }); save();
};

window.addEventListener('hashchange', showTab);
showTab();
render();
setInterval(function () { $('stat-start').value = timeAgo(settings.start_date); }, 60000);
$('pokemon-list').innerHTML = Object.keys(POKEMON).map(function (n) { return '<option value="' + n + '">'; }).join('');
