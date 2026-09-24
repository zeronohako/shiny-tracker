var $ = function (id) { return document.getElementById(id); };
var SPRITES = 'https://play.pokemonshowdown.com/sprites/';

var state = loadState(JSON.parse(localStorage.getItem('state')), JSON.parse(localStorage.getItem('settings')));
function hunt() { return state.hunts[state.selected] || state.hunts[0]; }

function save() { localStorage.setItem('state', JSON.stringify(state)); render(); }

function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

// ponytail: re-renders the whole list on every change (restarts sprite animations); patch per card if that bugs you
function card(h, i) {
  var id = POKEMON[h.target];
  return '<div class="hunt' + (h === hunt() ? ' selected' : '') + '" data-i="' + i + '">' +
    (id ? '<img src="' + SPRITES + 'ani-shiny/' + id + '.gif" onerror="this.onerror=null;this.src=\'' + SPRITES + 'gen5-shiny/' + id + '.png\'" alt="' + esc(h.target) + '">' : '') +
    '<div class="info"><b>' + esc(h.target || 'New hunt') + '</b><small>Gen ' + h.generation + ' · ' + oddsText(h) + '</small></div>' +
    '<button class="btn danger" data-act="dec" aria-label="Decrease">−</button>' +
    '<button class="count" data-act="edit" title="Click to edit">' + h.encounters.toLocaleString() + '</button>' +
    '<button class="btn success" data-act="inc" aria-label="Increase">+</button>' +
    '<button class="btn remove" data-act="remove" aria-label="Remove hunt" title="Remove hunt">✕</button></div>';
}

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
  var h = hunt();
  document.body.classList.toggle('dark', state.dark_theme);
  // Track tab
  $('hunts').innerHTML = state.hunts.map(card).join('');
  $('stats').hidden = !state.show_stats;
  $('stat-start').value = timeAgo(h.start_date);
  $('stat-odds').value = oddsText(h);
  $('stat-binom').value = binomialPct(h).toFixed(2) + '%';
  $('stat-remaining').value = remainingTo90(h).toLocaleString();
  // Setup tab
  setActive('gen-group', 'gen', h.generation);
  $('charm-block').hidden = h.generation < 5;
  setActive('charm-group', 'charm', h.shiny_charm);
  $('method').value = h.encounter_method;
  $('gen9-block').hidden = h.generation !== 9;
  setActive('sandwich-group', 'sandwich', h.sandwich);
  setActive('outbreak-group', 'outbreak', h.outbreak);
  $('target').value = h.target;
  $('start-date').value = toLocalInput(h.start_date);
  $('editing').textContent = h.target || 'New hunt';
  setActive('stats-group', 'stats', state.show_stats);
  setActive('theme-group', 'theme', state.dark_theme);
}

function showTab() {
  var tab = location.hash.slice(1) || 'track';
  if (!$(tab) || !$(tab).classList.contains('panel')) tab = 'track';
  ['track', 'setup', 'about'].forEach(function (t) { $(t).hidden = t !== tab; });
  document.querySelectorAll('.tabs a').forEach(function (a) { a.classList.toggle('active', a.dataset.tab === tab); });
}

function bindGroup(groupId, attr, key, parse, global) {
  $(groupId).addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    (global ? state : hunt())[key] = parse(b.dataset[attr]); save();
  });
}
var toBool = function (v) { return v === 'true'; };

$('hunts').onclick = function (e) {
  var c = e.target.closest('.hunt'); if (!c) return;
  var i = +c.dataset.i, h = state.hunts[i], b = e.target.closest('[data-act]'), act = b && b.dataset.act;
  if (act === 'remove') {
    if (!confirm('Remove the ' + (h.target || 'new') + ' hunt?')) return;
    state.hunts.splice(i, 1);
    if (!state.hunts.length) state.hunts.push(newHunt());
    state.selected = Math.min(state.selected > i ? state.selected - 1 : state.selected, state.hunts.length - 1);
    return save();
  }
  state.selected = i;
  if (act === 'inc') h.encounters++;
  if (act === 'dec' && h.encounters > 0) h.encounters--;
  save();
  if (act === 'edit') { $('edit-count').value = h.encounters; $('edit-dialog').showModal(); $('edit-count').select(); }
};
$('add').onclick = function () {
  state.hunts.push(newHunt(hunt()));
  state.selected = state.hunts.length - 1; save();
  location.hash = 'setup';
};
$('edit-dialog').onclose = function () {
  if ($('edit-dialog').returnValue !== 'save') return;
  hunt().encounters = Math.max(0, Math.floor(+$('edit-count').value) || 0); save();
};

bindGroup('gen-group', 'gen', 'generation', Number);
bindGroup('charm-group', 'charm', 'shiny_charm', toBool);
bindGroup('sandwich-group', 'sandwich', 'sandwich', Number);
bindGroup('outbreak-group', 'outbreak', 'outbreak', Number);
bindGroup('stats-group', 'stats', 'show_stats', toBool, true);
bindGroup('theme-group', 'theme', 'dark_theme', toBool, true);
$('method').onchange = function () { hunt().encounter_method = this.value; save(); };
$('target').onchange = function () { hunt().target = this.value.trim(); save(); };
$('start-date').onchange = function () { if (this.value) { hunt().start_date = new Date(this.value).toISOString(); save(); } };
$('reset').onclick = function () {
  if (!confirm('Reset this hunt\'s encounter count and start date?')) return;
  hunt().encounters = 0; hunt().start_date = new Date().toISOString(); save();
};

window.addEventListener('hashchange', showTab);
showTab();
render();
setInterval(function () { $('stat-start').value = timeAgo(hunt().start_date); }, 60000);
$('pokemon-list').innerHTML = Object.keys(POKEMON).map(function (n) { return '<option value="' + n + '">'; }).join('');
