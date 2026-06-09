/* ============================================================
 * Aetherius Control Panel — browser client.
 *
 * Vanilla JS, no build step, no frameworks. Talks to the relay
 * server over a SAME-ORIGIN WebSocket. The relay forwards our
 * frontend::* messages upstream to the coordinator verbatim and
 * broadcasts coordinator::* messages back down to us.
 *
 * WIRE CONTRACT (must match coordinator + relay + shared-types):
 *   browser -> coordinator:
 *     frontend::chat            { message, sender? }
 *     frontend::startGoal       { goal, count }
 *     frontend::updateWhitelist { enabled, players: string[] }
 *     frontend::getState        {}
 *   coordinator -> browser:
 *     coordinator::chat   { from, kind: 'coordinator'|'player'|'system', message, ts }
 *     coordinator::state  CoordinatorStatePayload
 * ============================================================ */

'use strict';

// ---- Wire type constants (single source of truth for this client) ----
const MSG = Object.freeze({
  // outbound
  FRONTEND_CHAT: 'frontend::chat',
  FRONTEND_START_GOAL: 'frontend::startGoal',
  FRONTEND_UPDATE_WHITELIST: 'frontend::updateWhitelist',
  FRONTEND_GET_STATE: 'frontend::getState',
  // inbound
  COORDINATOR_CHAT: 'coordinator::chat',
  COORDINATOR_STATE: 'coordinator::state',
});

const RECONNECT_MS = 3000;
const MAX_CHAT_LINES = 500; // cap DOM growth on long sessions

// ---- In-memory app state ----
const state = {
  /** @type {WebSocket|null} */
  ws: null,
  connected: false,
  /** latest CoordinatorStatePayload.goals */
  goals: [],
  /** latest CoordinatorStatePayload.agents */
  agents: [],
  /** working copy of the whitelist the user edits before Save */
  whitelist: { enabled: false, players: [] },
  /** true once the user touches the whitelist UI since last server snapshot */
  whitelistDirty: false,
};

// ---- DOM handles (populated on DOMContentLoaded) ----
let el = {};

document.addEventListener('DOMContentLoaded', () => {
  el = {
    connDot: document.getElementById('conn-dot'),
    connLabel: document.getElementById('conn-label'),

    chatLog: document.getElementById('chat-log'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    senderInput: document.getElementById('sender-input'),

    goalsList: document.getElementById('goals-list'),
    goalsCount: document.getElementById('goals-count'),
    goalForm: document.getElementById('goal-form'),
    goalInput: document.getElementById('goal-input'),

    agentsList: document.getElementById('agents-list'),
    agentsCount: document.getElementById('agents-count'),

    wlEnabled: document.getElementById('wl-enabled'),
    wlChips: document.getElementById('wl-chips'),
    wlAddForm: document.getElementById('wl-add-form'),
    wlAddInput: document.getElementById('wl-add-input'),
    wlSave: document.getElementById('wl-save'),
    wlStatus: document.getElementById('wl-status'),
  };

  wireUi();
  renderGoals();
  renderAgents();
  renderWhitelist();
  connect();
});

// ============================================================
// WebSocket: connect, receive, reconnect
// ============================================================

function connect() {
  // Same-origin WS. Honor wss:// when the page is served over https.
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = proto + location.host;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[ws] construct failed:', err);
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    setConnected(true);
    // Pull a fresh snapshot so panels populate immediately.
    send(MSG.FRONTEND_GET_STATE, {});
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (err) {
      console.warn('[ws] non-JSON frame ignored:', err);
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConnected(false);
    state.ws = null;
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // The 'close' handler drives reconnect; just surface it.
    console.warn('[ws] socket error');
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return; // already pending
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function setConnected(ok) {
  state.connected = ok;
  if (!el.connDot) return;
  el.connDot.dataset.state = ok ? 'connected' : 'disconnected';
  el.connDot.title = ok ? 'Connected' : 'Disconnected';
  el.connLabel.textContent = ok ? 'connected' : 'disconnected';
}

/** Send an envelope upstream. Silently no-ops when disconnected. */
function send(type, payload) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[ws] not connected; dropping', type);
    return false;
  }
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

// ============================================================
// Inbound message routing
// ============================================================

function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case MSG.COORDINATOR_CHAT:
      onCoordinatorChat(msg.payload || {});
      break;
    case MSG.COORDINATOR_STATE:
      onCoordinatorState(msg.payload || {});
      break;
    default:
      // Other relay/coordinator frames are not rendered here.
      break;
  }
}

function onCoordinatorChat(p) {
  appendChat({
    from: typeof p.from === 'string' && p.from ? p.from : '?',
    kind: normalizeKind(p.kind),
    message: typeof p.message === 'string' ? p.message : '',
    ts: typeof p.ts === 'string' ? p.ts : '',
  });
}

function onCoordinatorState(p) {
  state.goals = Array.isArray(p.goals) ? p.goals : [];
  state.agents = Array.isArray(p.agents) ? p.agents : [];

  const wl = p.whitelist && typeof p.whitelist === 'object' ? p.whitelist : {};
  const players = Array.isArray(wl.players) ? wl.players.filter((x) => typeof x === 'string') : [];
  // A server snapshot is authoritative: adopt it and clear the dirty flag.
  // (Saves are confirmed by the next state broadcast, per the contract.)
  state.whitelist = { enabled: !!wl.enabled, players };
  state.whitelistDirty = false;

  renderGoals();
  renderAgents();
  renderWhitelist();
  markWhitelistStatus('saved');
}

function normalizeKind(kind) {
  return kind === 'coordinator' || kind === 'player' || kind === 'system' ? kind : 'system';
}

// ============================================================
// CHAT rendering
// ============================================================

function appendChat({ from, kind, message, ts }) {
  // Drop the empty-state placeholder once real lines arrive.
  const placeholder = el.chatLog.querySelector('.chat-empty');
  if (placeholder) placeholder.remove();

  const nearBottom = isScrolledToBottom(el.chatLog);

  const line = document.createElement('div');
  line.className = 'chat-line kind-' + kind;

  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = formatTs(ts);
  line.appendChild(tsSpan);

  // System lines read more naturally without a "from" label.
  if (kind !== 'system') {
    const fromSpan = document.createElement('span');
    fromSpan.className = 'from';
    fromSpan.textContent = labelFor(from, kind);
    line.appendChild(fromSpan);
  }

  const msgSpan = document.createElement('span');
  msgSpan.className = 'msg';
  msgSpan.textContent = message;
  line.appendChild(msgSpan);

  el.chatLog.appendChild(line);

  // Trim old lines to bound memory/DOM.
  while (el.chatLog.children.length > MAX_CHAT_LINES) {
    el.chatLog.removeChild(el.chatLog.firstChild);
  }

  // Auto-scroll only if the user was already at the bottom.
  if (nearBottom) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function labelFor(from, kind) {
  if (kind === 'coordinator') return 'Coordinator';
  return from || 'player';
}

/** Parse an ISO-8601 ts into HH:MM:SS; fall back gracefully. */
function formatTs(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--:--:--';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function isScrolledToBottom(node) {
  // Within 24px of the bottom counts as "at bottom".
  return node.scrollHeight - node.scrollTop - node.clientHeight < 24;
}

// ============================================================
// GOALS rendering
// ============================================================

function renderGoals() {
  const list = el.goalsList;
  list.innerHTML = '';
  el.goalsCount.textContent = String(state.goals.length);

  if (state.goals.length === 0) {
    list.appendChild(emptyNote('No active goals.'));
    return;
  }

  for (const g of state.goals) {
    const desc = str(g && g.description, '(no description)');
    const priority = str(g && g.priority, 'unknown');
    const status = str(g && g.status, 'unknown');
    const goalId = str(g && g.goalId, '');

    const card = document.createElement('div');
    card.className = 'card prio-' + prioClass(priority);

    const row = document.createElement('div');
    row.className = 'card-row';

    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = desc;
    row.appendChild(title);

    const prioBadge = document.createElement('span');
    prioBadge.className = 'badge prio-' + prioClass(priority);
    prioBadge.textContent = priority;
    row.appendChild(prioBadge);

    card.appendChild(row);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.appendChild(kv('status', status));
    if (goalId) meta.appendChild(kv('id', goalId));
    card.appendChild(meta);

    list.appendChild(card);
  }
}

function prioClass(priority) {
  const p = String(priority).toLowerCase();
  if (p === 'high') return 'high';
  if (p === 'medium' || p === 'med') return 'medium';
  if (p === 'low') return 'low';
  return 'unknown';
}

// ============================================================
// AGENTS rendering
// ============================================================

function renderAgents() {
  const list = el.agentsList;
  list.innerHTML = '';
  el.agentsCount.textContent = String(state.agents.length);

  if (state.agents.length === 0) {
    list.appendChild(emptyNote('No agents online.'));
    return;
  }

  for (const a of state.agents) {
    const agentId = str(a && a.agentId, '(unknown)');
    const status = str(a && a.status, 'unknown');
    const currentTask = a && a.currentTask != null ? String(a.currentTask) : null;
    const position = a && a.position && typeof a.position === 'object' ? a.position : null;
    const inventory = a && a.inventory && typeof a.inventory === 'object' ? a.inventory : {};

    const card = document.createElement('div');
    card.className = 'card';

    const row = document.createElement('div');
    row.className = 'card-row';

    const id = document.createElement('span');
    id.className = 'card-title card-id';
    id.textContent = agentId;
    row.appendChild(id);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge status st-' + statusClass(status);
    statusBadge.textContent = status;
    row.appendChild(statusBadge);

    card.appendChild(row);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.appendChild(kv('task', currentTask ? currentTask : 'idle'));
    card.appendChild(meta);

    // Position
    const posDiv = document.createElement('div');
    posDiv.className = 'pos card-meta';
    posDiv.appendChild(document.createTextNode('pos '));
    if (position && isNum(position.x) && isNum(position.y) && isNum(position.z)) {
      posDiv.appendChild(axis('x', position.x));
      posDiv.appendChild(axis('y', position.y));
      posDiv.appendChild(axis('z', position.z));
    } else {
      const unk = document.createElement('span');
      unk.className = 'k';
      unk.textContent = 'unknown';
      posDiv.appendChild(unk);
    }
    card.appendChild(posDiv);

    // Inventory
    const inv = document.createElement('div');
    inv.className = 'inv';
    const entries = Object.entries(inventory).filter(([, c]) => isNum(c));
    if (entries.length === 0) {
      const e = document.createElement('span');
      e.className = 'inv-empty';
      e.textContent = 'empty inventory';
      inv.appendChild(e);
    } else {
      for (const [item, count] of entries) {
        const chip = document.createElement('span');
        chip.className = 'inv-item';
        chip.textContent = item + ' ';
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = String(count);
        chip.appendChild(n);
        inv.appendChild(chip);
      }
    }
    card.appendChild(inv);

    list.appendChild(card);
  }
}

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (s === 'idle') return 'idle';
  if (s === 'busy' || s === 'working' || s === 'active') return 'busy';
  return 'unknown';
}

function axis(name, value) {
  const span = document.createElement('span');
  const a = document.createElement('span');
  a.className = 'axis';
  a.textContent = name + ':';
  span.appendChild(a);
  span.appendChild(document.createTextNode(roundCoord(value) + '  '));
  return span;
}

function roundCoord(v) {
  return Math.round(v * 10) / 10;
}

// ============================================================
// WHITELIST rendering + editing
// ============================================================

function renderWhitelist() {
  el.wlEnabled.checked = !!state.whitelist.enabled;

  const chips = el.wlChips;
  chips.innerHTML = '';
  for (const name of state.whitelist.players) {
    chips.appendChild(makeChip(name));
  }
}

function makeChip(name) {
  const chip = document.createElement('span');
  chip.className = 'chip';

  const label = document.createElement('span');
  label.textContent = name;
  chip.appendChild(label);

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'chip-x';
  x.title = 'Remove ' + name;
  x.setAttribute('aria-label', 'Remove ' + name);
  x.textContent = '×'; // ×
  x.addEventListener('click', () => {
    state.whitelist.players = state.whitelist.players.filter((n) => n !== name);
    markWhitelistDirty();
    renderWhitelist();
  });
  chip.appendChild(x);

  return chip;
}

function addWhitelistName(raw) {
  const name = String(raw || '').trim();
  if (!name) return;
  // Case-insensitive de-dupe; keep the first-seen casing.
  const exists = state.whitelist.players.some((n) => n.toLowerCase() === name.toLowerCase());
  if (exists) return;
  state.whitelist.players.push(name);
  markWhitelistDirty();
  renderWhitelist();
}

function saveWhitelist() {
  const payload = {
    enabled: !!state.whitelist.enabled,
    players: state.whitelist.players.slice(),
  };
  const ok = send(MSG.FRONTEND_UPDATE_WHITELIST, payload);
  if (ok) {
    // The authoritative confirmation is the next coordinator::state.
    markWhitelistStatus('saving');
  } else {
    markWhitelistStatus('offline');
  }
}

function markWhitelistDirty() {
  state.whitelistDirty = true;
  markWhitelistStatus('dirty');
}

function markWhitelistStatus(kind) {
  const node = el.wlStatus;
  if (!node) return;
  node.classList.remove('dirty', 'saved');
  switch (kind) {
    case 'dirty':
      node.textContent = 'unsaved changes';
      node.classList.add('dirty');
      break;
    case 'saving':
      node.textContent = 'saving…';
      break;
    case 'saved':
      node.textContent = state.whitelistDirty ? 'unsaved changes' : 'in sync';
      if (!state.whitelistDirty) node.classList.add('saved');
      else node.classList.add('dirty');
      break;
    case 'offline':
      node.textContent = 'offline — not saved';
      node.classList.add('dirty');
      break;
    default:
      node.textContent = '';
  }
}

// ============================================================
// UI wiring (event listeners)
// ============================================================

function wireUi() {
  // --- Chat send ---
  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = el.chatInput.value.trim();
    if (!message) return;
    const sender = (el.senderInput.value || '').trim() || 'Web';
    // Do NOT echo locally; the coordinator mirrors it back as a 'player' line.
    const ok = send(MSG.FRONTEND_CHAT, { message, sender });
    if (ok) el.chatInput.value = '';
  });

  // --- Start goal ---
  el.goalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const goal = el.goalInput.value.trim();
    if (!goal) return;
    const ok = send(MSG.FRONTEND_START_GOAL, { goal, count: 1 });
    if (ok) el.goalInput.value = '';
  });

  // --- Whitelist: enabled toggle ---
  el.wlEnabled.addEventListener('change', () => {
    state.whitelist.enabled = el.wlEnabled.checked;
    markWhitelistDirty();
  });

  // --- Whitelist: add username ---
  el.wlAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addWhitelistName(el.wlAddInput.value);
    el.wlAddInput.value = '';
    el.wlAddInput.focus();
  });

  // --- Whitelist: save ---
  el.wlSave.addEventListener('click', () => saveWhitelist());
}

// ============================================================
// Small helpers
// ============================================================

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function kv(key, value) {
  const span = document.createElement('span');
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key + ': ';
  span.appendChild(k);
  span.appendChild(document.createTextNode(value));
  span.appendChild(document.createTextNode('  '));
  return span;
}

function str(v, fallback) {
  if (v == null) return fallback;
  const s = String(v);
  return s.length ? s : fallback;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}
