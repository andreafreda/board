// ════════════════════════════════════════════════════════════════════
//   calendar.js — v3 calendar view (Day / Week / Month)
// ════════════════════════════════════════════════════════════════════
// The calendar is a sister view to the board — it lives in its own
// container (#calendarView) that hides the canvas when active.
//
// As of v3.1 events come from real Google Calendar accounts via the
// calendar-events-google Edge Function. When the user isn't signed in
// (or hasn't connected any account yet) we fall back to the mock data
// so the empty calendar still looks alive.

import { dom } from './dom.js';
import { state, save, uid, NOTE_COLOR_MAP } from './state.js';
import { renderNotes } from './notes.js';
import { broadcastNoteUpsert } from './realtime.js';
import { getClient } from './db.js';
import { getCurrentUser } from './auth.js';

// ── Mock data — replace with Edge Function calls in v3.1+ ──────────
// Account colors keep separation from the post-it palette so the user
// doesn't confuse "calendar source" with "note color".
export const ACCOUNT_COLORS = {
  work:     '#1A6B5A',
  personal: '#7C5CE6',
  family:   '#E67C5C',
  team:     '#5CB8E6',
};

export const ACCOUNTS = [
  { id: 'work',     name: 'Lavoro',    email: 'andrea@studio.com',   provider: 'google',  color: ACCOUNT_COLORS.work,     enabled: true },
  { id: 'personal', name: 'Personale', email: 'andrea.freda@gmail.com', provider: 'google', color: ACCOUNT_COLORS.personal, enabled: true },
  { id: 'family',   name: 'Famiglia',  email: 'famiglia@icloud.com', provider: 'apple',   color: ACCOUNT_COLORS.family,   enabled: true },
  { id: 'team',     name: 'Team',      email: 'team@studio.com',     provider: 'outlook', color: ACCOUNT_COLORS.team,     enabled: false },
];

export const SHARED_CALENDARS = [
  { id: 'sc-marco', owner: 'Marco Rossi',   initial: 'M', color: '#7C5CE6', enabled: true,  presence: true  },
  { id: 'sc-sofia', owner: 'Sofia Bianchi', initial: 'S', color: '#E67C5C', enabled: true,  presence: false },
];

// Generate mock events relative to today so the calendar is always
// populated. Day offsets are relative to *Monday* of the current week.
function buildMockEvents() {
  const now = new Date();
  const dow  = (now.getDay() + 6) % 7;          // 0 = Mon
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow);
  monday.setHours(0, 0, 0, 0);

  const at = (dayOffset, hh, mm = 0) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return d.toISOString();
  };
  const mins = (iso, m) => new Date(new Date(iso).getTime() + m * 60_000).toISOString();
  const ev = (id, dayOffset, startH, startM, durMin, title, account, location = '') => ({
    id, title, location,
    startAt: at(dayOffset, startH, startM),
    endAt:   mins(at(dayOffset, startH, startM), durMin),
    allDay:  false,
    account,
    accountEmail: ACCOUNTS.find(a => a.id === account)?.email || '',
    provider:     ACCOUNTS.find(a => a.id === account)?.provider || 'google',
    onBoard:      false, // toggled when user sends event → board
  });

  return [
    // Mon
    ev('e1', 0,  9,  0, 60,  'Daily standup',          'work',     'Meet'),
    ev('e2', 0, 11,  0, 90,  'Review redesign Board',  'work',     'Sala Quercia'),
    ev('e3', 0, 13, 30, 45,  'Pranzo',                 'personal', ''),
    ev('e4', 0, 16,  0, 60,  'Deadline mockup v2',     'work',     ''),
    // Tue
    ev('e5', 1,  9, 30, 30,  '1:1 con Sofia',          'work',     ''),
    ev('e6', 1, 10, 30, 120, 'Workshop discovery',     'work',     'Sala grande'),
    ev('e7', 1, 15,  0, 60,  'Dentista',               'personal', 'Via Garibaldi 12'),
    ev('e8', 1, 18, 30, 90,  'Yoga',                   'personal', ''),
    // Wed
    ev('e9',  2,  9,  0, 60,  'Daily standup',         'work',     ''),
    ev('e10', 2, 10,  0, 30,  'Sync con Marco',        'work',     ''),
    ev('e11', 2, 14,  0, 180, 'Sessione design',       'work',     ''),
    ev('e12', 2, 19,  0, 120, 'Cena con Giulia',       'personal', 'Trattoria del Borgo'),
    // Thu
    ev('e13', 3,  9,  0, 60,  'Daily standup',         'work',     ''),
    ev('e14', 3, 11,  0, 60,  'Demo cliente',          'work',     'Meet'),
    ev('e15', 3, 12,  0, 60,  'Pranzo team',           'work',     ''),
    ev('e16', 3, 15, 30, 90,  'Compleanno Marco',      'personal', 'Ufficio'),
    // Fri
    ev('e17', 4, 10,  0, 60,  'Retrospettiva sprint',  'work',     ''),
    ev('e18', 4, 14,  0, 60,  'Pediatra',              'family',   'Studio Verdi'),
    ev('e19', 4, 17,  0, 60,  'Aperitivo',             'personal', ''),
    // Sat
    ev('e20', 5, 10,  0, 240, 'Gita al lago',          'family',   'Lago di Como'),
    ev('e21', 5, 20,  0, 180, 'Cena fuori',            'personal', ''),
    // Sun
    ev('e22', 6, 11,  0, 60,  'Brunch in famiglia',    'family',   ''),
  ];
}

// Calendar-only state (kept separate from board state)
export const calState = {
  events:      buildMockEvents(),
  view:        'week',              // 'day' | 'week' | 'month'
  cursor:      new Date(),
  active:      false,               // calendar mode on/off
  // v3.1: real provider data (set after loadConnections / loadEvents)
  connections: [],                  // [{ id, account_email, display_color, enabled }]
  loading:     false,
  error:       null,
  source:      'mock',              // 'mock' | 'real' | 'empty'
};

// Pick a colour for an event:
//   • real events carry calendarColor in the payload
//   • mock events use ACCOUNT_COLORS[account]
const accountColor = (e) => {
  if (e.calendarColor) return e.calendarColor;
  if (e.account)       return (ACCOUNTS.find(a => a.id === e.account) || {}).color || '#1A6B5A';
  return '#1A6B5A';
};

// ── Real provider data via Edge Functions ──────────────────────────
const SUPABASE_URL    = 'https://qphyrsdtegxvnwaqixeb.supabase.co';
const FN_OAUTH_GOOGLE = `${SUPABASE_URL}/functions/v1/calendar-oauth-google`;
const FN_EVENTS_GOOGLE = `${SUPABASE_URL}/functions/v1/calendar-events-google`;

async function getAccessToken() {
  const client = await getClient();
  const { data: { session } } = await client.auth.getSession();
  return session?.access_token || null;
}

export async function loadConnections() {
  if (!getCurrentUser()) { calState.connections = []; return; }
  try {
    const client = await getClient();
    const { data, error } = await client.from('calendar_connections')
      .select('id, provider, account_email, display_color, enabled, token_expiry')
      .order('created_at', { ascending: true });
    if (error) throw error;
    calState.connections = data || [];
  } catch (e) {
    console.warn('[cal] loadConnections failed:', e.message);
    calState.connections = [];
  }
}

export async function loadEvents() {
  if (!getCurrentUser() || calState.connections.length === 0) {
    // No real accounts → keep the mocks so the calendar looks alive
    calState.source = calState.connections.length === 0 ? 'empty' : 'mock';
    return;
  }
  calState.loading = true;
  calState.error   = null;
  try {
    const token = await getAccessToken();
    if (!token) throw new Error('not signed in');
    // Fetch a 4-week window centred on the current cursor so navigation
    // back/forward stays inside the cache for a while.
    const c = calState.cursor;
    const min = new Date(c); min.setDate(min.getDate() - 21); min.setHours(0,0,0,0);
    const max = new Date(c); max.setDate(max.getDate() + 21); max.setHours(23,59,59,999);
    const res = await fetch(FN_EVENTS_GOOGLE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ time_min: min.toISOString(), time_max: max.toISOString() }),
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    calState.events = json.events || [];
    calState.source = 'real';
  } catch (e) {
    console.warn('[cal] loadEvents failed:', e.message);
    calState.error = e.message;
    calState.source = 'real';
  } finally {
    calState.loading = false;
  }
}

// Kick off the OAuth flow — POST to the Edge Function with the user's JWT,
// receive the consent URL, then full-page-redirect there.
export async function connectGoogle() {
  if (!getCurrentUser()) {
    alert('Accedi prima con Google per connettere un calendario.');
    return;
  }
  try {
    const token = await getAccessToken();
    const res = await fetch(`${FN_OAUTH_GOOGLE}?action=start`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ app_url: location.origin + location.pathname }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { url } = await res.json();
    if (!url) throw new Error('No URL returned');
    location.href = url;
  } catch (e) {
    console.error('[cal] connectGoogle failed:', e);
    alert('Connessione fallita: ' + e.message);
  }
}

export async function disconnectAccount(connectionId) {
  try {
    const client = await getClient();
    await client.from('calendar_connections').delete().eq('id', connectionId);
    await loadConnections();
    await loadEvents();
    if (calState.active) renderCalendar();
  } catch (e) {
    console.warn('[cal] disconnect failed:', e.message);
  }
}

// ── Date helpers ────────────────────────────────────────────────────
const startOfWeek = (d) => {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
};
const startOfMonth = (d) => { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; };
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth()    === b.getMonth() &&
  a.getDate()     === b.getDate();
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const fmtTime = (iso) => {
  const d = new Date(iso);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
};
const eventMins = (e) => Math.round((new Date(e.endAt) - new Date(e.startAt)) / 60_000);

const MONTH_NAMES = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const DAY_NAMES_LONG  = ['Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato','Domenica'];
const DAY_NAMES_SHORT = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];

// ── SVG icon helpers ────────────────────────────────────────────────
const svg = {
  chevL: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  chevR: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  pin:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  noteIcon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 8h10M7 12h6"/></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
  board: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  google: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
  outlook: '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="#0078D4" d="M14 4h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7V4z"/><path fill="#0078D4" d="M2 5l11-2v18L2 19V5z"/><circle cx="7.5" cy="12" r="3.5" fill="#fff"/><circle cx="7.5" cy="12" r="1.8" fill="#0078D4"/></svg>',
  apple:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="#1A1714"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>',
};

// ── Core renderers ──────────────────────────────────────────────────

const HOUR_PX = 56;
const START_H = 7;
const END_H   = 22;

function renderHeader() {
  const v = calState.view;
  const c = calState.cursor;

  let title = '';
  if (v === 'day') {
    title = `${DAY_NAMES_LONG[(c.getDay() + 6) % 7]} ${c.getDate()} ${MONTH_NAMES[c.getMonth()].toLowerCase()}`;
  } else if (v === 'week') {
    const wkStart = startOfWeek(c);
    const wkEnd   = addDays(wkStart, 6);
    if (wkStart.getMonth() === wkEnd.getMonth()) {
      title = `${wkStart.getDate()}–${wkEnd.getDate()} ${MONTH_NAMES[wkStart.getMonth()].toLowerCase()} ${wkStart.getFullYear()}`;
    } else {
      title = `${wkStart.getDate()} ${MONTH_NAMES[wkStart.getMonth()].slice(0,3).toLowerCase()}–${wkEnd.getDate()} ${MONTH_NAMES[wkEnd.getMonth()].slice(0,3).toLowerCase()} ${wkStart.getFullYear()}`;
    }
  } else {
    title = `${MONTH_NAMES[c.getMonth()]} ${c.getFullYear()}`;
  }

  return `
    <button class="cal-back" data-cal-back aria-label="Torna alla board">
      ${svg.chevL}<span>Board</span>
    </button>
    <div class="cal-nav">
      <button class="cal-navbtn" data-cal-nav="prev" aria-label="Precedente">${svg.chevL}</button>
      <button class="cal-todaybtn" data-cal-nav="today">Oggi</button>
      <button class="cal-navbtn" data-cal-nav="next" aria-label="Successivo">${svg.chevR}</button>
    </div>
    <div class="cal-title" id="calTitle">${title}</div>
    <div class="cal-spacer"></div>
    <div class="cal-segmented" role="tablist">
      <button class="cal-seg ${v === 'day'   ? 'on' : ''}" data-cal-view="day">Giorno</button>
      <button class="cal-seg ${v === 'week'  ? 'on' : ''}" data-cal-view="week">Settimana</button>
      <button class="cal-seg ${v === 'month' ? 'on' : ''}" data-cal-view="month">Mese</button>
    </div>
  `;
}

// Hook so modes.js can hand us a "leave calendar mode" callback. Avoids
// importing modes.js (which would create a cycle).
let _onLeave = null;
export function setOnLeave(fn) { _onLeave = fn; }

function renderDay() {
  const c = calState.cursor;
  const todayEvents = calState.events
    .filter(e => sameDay(new Date(e.startAt), c))
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const isToday = sameDay(c, new Date());

  return `
    <div class="cal-grid cal-grid-day">
      <div class="cal-time-col">
        ${Array.from({ length: END_H - START_H + 1 }, (_, i) => `
          <div class="cal-time-slot">
            <span class="cal-time-label">${String(i + START_H).padStart(2, '0')}:00</span>
          </div>
        `).join('')}
      </div>
      <div class="cal-day-col" data-day="0">
        ${Array.from({ length: END_H - START_H + 1 }, () => '<div class="cal-time-slot"></div>').join('')}
        ${isToday ? renderNowLine() : ''}
        ${todayEvents.map(renderEventBlock).join('')}
      </div>
    </div>
  `;
}

function renderWeek() {
  const wkStart = startOfWeek(calState.cursor);
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(wkStart, i));

  const headers = days.map((d, i) => `
    <div class="cal-day-header ${sameDay(d, today) ? 'today' : ''}">
      <div class="cal-dh-name">${DAY_NAMES_SHORT[i]}</div>
      <div class="cal-dh-num">${d.getDate()}</div>
    </div>
  `).join('');

  const cols = days.map((d, i) => {
    const dayEv = calState.events.filter(e => sameDay(new Date(e.startAt), d));
    return `
      <div class="cal-day-col" data-day="${i}">
        ${Array.from({ length: END_H - START_H + 1 }, () => '<div class="cal-time-slot"></div>').join('')}
        ${sameDay(d, today) ? renderNowLine() : ''}
        ${dayEv.map(renderEventBlock).join('')}
      </div>
    `;
  }).join('');

  return `
    <div class="cal-week-headers">
      <div class="cal-time-col-head"></div>
      ${headers}
    </div>
    <div class="cal-grid cal-grid-week">
      <div class="cal-time-col">
        ${Array.from({ length: END_H - START_H + 1 }, (_, i) => `
          <div class="cal-time-slot">
            <span class="cal-time-label">${String(i + START_H).padStart(2, '0')}:00</span>
          </div>
        `).join('')}
      </div>
      ${cols}
    </div>
  `;
}

function renderMonth() {
  const monthStart = startOfMonth(calState.cursor);
  const gridStart = startOfWeek(monthStart);
  const today = new Date();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const curMonth = calState.cursor.getMonth();

  const headers = DAY_NAMES_SHORT.map(n =>
    `<div class="cal-mhdr">${n}</div>`).join('');

  const grid = cells.map(d => {
    const inMonth = d.getMonth() === curMonth;
    const isToday = sameDay(d, today);
    const dayEv = calState.events
      .filter(e => sameDay(new Date(e.startAt), d))
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const visible = dayEv.slice(0, 3);
    const overflow = dayEv.length - visible.length;

    return `
      <div class="cal-mcell ${inMonth ? '' : 'cal-mcell-out'}" data-cal-day="${d.toISOString()}">
        <div class="cal-mcell-head">
          <span class="cal-mcell-num ${isToday ? 'today' : ''}">${d.getDate()}</span>
        </div>
        ${visible.map(e => `
          <div class="cal-mevent" data-event-id="${e.id}"
               style="--c:${accountColor(e)}">
            <span class="cal-mevent-time">${fmtTime(e.startAt)}</span>
            <span class="cal-mevent-title">${escape(e.title)}</span>
          </div>
        `).join('')}
        ${overflow > 0 ? `<div class="cal-mevent-more">+${overflow}</div>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="cal-mgrid-headers">${headers}</div>
    <div class="cal-mgrid">${grid}</div>
  `;
}

function renderNowLine() {
  const now = new Date();
  const top = ((now.getHours() - START_H) * 60 + now.getMinutes()) * (HOUR_PX / 60);
  if (top < 0 || top > (END_H - START_H + 1) * HOUR_PX) return '';
  const t = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  return `
    <div class="cal-nowline" style="top:${top}px">
      <span class="cal-nowline-dot"></span>
      <span class="cal-nowline-time">${t}</span>
    </div>
  `;
}

function renderEventBlock(e) {
  const start = new Date(e.startAt);
  const top = ((start.getHours() - START_H) * 60 + start.getMinutes()) * (HOUR_PX / 60);
  const height = Math.max(20, eventMins(e) * (HOUR_PX / 60) - 2);
  return `
    <div class="cal-event ${e.onBoard ? 'cal-event-onboard' : ''}"
         data-event-id="${e.id}"
         style="--c:${accountColor(e)};top:${top}px;height:${height}px">
      <div class="cal-event-title">${escape(e.title)}${e.onBoard ? '<span class="cal-event-badge">SU BOARD</span>' : ''}</div>
      ${height > 32 ? `<div class="cal-event-meta">${fmtTime(e.startAt)}${e.location && height > 48 ? ' · ' + escape(e.location) : ''}</div>` : ''}
    </div>
  `;
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]
  ));
}

// ── Event detail popover + "Invia a board" flow ─────────────────────
let _popoverEl = null;

function openEventPopover(eventId, anchorEl) {
  closeEventPopover();
  const e = calState.events.find(x => x.id === eventId);
  if (!e) return;

  const start = new Date(e.startAt);
  // Real events carry accountEmail; mock events carry account.
  const sourceLabel = e.accountEmail
    || ACCOUNTS.find(a => a.id === e.account)?.email
    || '';
  const dateLabel = `${DAY_NAMES_LONG[(start.getDay() + 6) % 7]} ${start.getDate()} ${MONTH_NAMES[start.getMonth()].toLowerCase()}`;
  const timeLabel = `${fmtTime(e.startAt)} – ${fmtTime(e.endAt)} · ${eventMins(e)} min`;

  const pop = document.createElement('div');
  pop.className = 'cal-pop';
  pop.innerHTML = `
    <div class="cal-pop-head">
      <span class="cal-pop-source-dot" style="background:${accountColor(e)}"></span>
      <span class="cal-pop-source">${escape(sourceLabel)}</span>
      <button class="cal-pop-close" aria-label="Chiudi">${svg.close}</button>
    </div>
    <div class="cal-pop-title">${escape(e.title)}</div>
    <div class="cal-pop-row"><span class="cal-pop-row-label">📅</span><span>${dateLabel}</span></div>
    <div class="cal-pop-row"><span class="cal-pop-row-label">🕐</span><span>${timeLabel}</span></div>
    ${e.location ? `<div class="cal-pop-row"><span class="cal-pop-row-label">${svg.pin}</span><span>${escape(e.location)}</span></div>` : ''}
    <button class="cal-pop-cta" data-send-to-board="${e.id}">
      ${svg.arrow}<span>Aggiungi alla board</span>
    </button>
    ${e.onBoard ? '<div class="cal-pop-onboard">Già aggiunto a una board</div>' : ''}
  `;

  // Position near the event's bounding box, but kept inside viewport.
  const rect = anchorEl.getBoundingClientRect();
  document.body.appendChild(pop);
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = rect.right + 10;
  let top  = rect.top;
  if (left + pw > window.innerWidth - 10) left = rect.left - pw - 10;
  if (left < 10) left = 10;
  if (top + ph > window.innerHeight - 10) top = window.innerHeight - ph - 10;
  if (top < 10) top = 10;
  pop.style.left = left + 'px';
  pop.style.top  = top + 'px';
  _popoverEl = pop;

  pop.querySelector('.cal-pop-close').addEventListener('click', closeEventPopover);
  pop.querySelector('.cal-pop-cta')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventPopover();
    openBoardPicker(e);
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, { once: false });
  }, 0);
}

function closeOnOutside(ev) {
  if (_popoverEl && !_popoverEl.contains(ev.target) && !ev.target.closest('.cal-event, .cal-mevent')) {
    closeEventPopover();
  }
}

function closeEventPopover() {
  document.removeEventListener('click', closeOnOutside);
  if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
}

// ── Board picker dialog ─────────────────────────────────────────────
function openBoardPicker(event) {
  closeEventPopover();
  const boards = (state.boards || []).filter(b => (b.myRole || 'owner') === 'owner');

  // If the user has only one board, skip the picker entirely
  if (boards.length === 1) {
    sendEventToBoard(event, boards[0].id);
    return;
  }
  if (boards.length === 0) {
    showToast('Nessuna board disponibile', 'warn');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'cal-modal-overlay';
  overlay.innerHTML = `
    <div class="cal-modal">
      <div class="cal-modal-head">
        <div class="cal-modal-icon">${svg.noteIcon}</div>
        <div class="cal-modal-titles">
          <div class="cal-modal-title">Aggiungi alla board</div>
          <div class="cal-modal-sub">${escape(event.title)}</div>
        </div>
        <button class="cal-modal-close" aria-label="Chiudi">${svg.close}</button>
      </div>
      <div class="cal-modal-section-label">Le tue board</div>
      <div class="cal-modal-list">
        ${boards.map((b, i) => `
          <button class="cal-board-item ${i === 0 ? 'sel' : ''}" data-board-id="${b.id}">
            <span class="cal-board-icon">${svg.board}</span>
            <span class="cal-board-name">${escape(b.name)}</span>
            ${i === 0 ? `<span class="cal-board-check">${svg.check}</span>` : ''}
          </button>
        `).join('')}
      </div>
      <button class="cal-modal-cta" data-confirm>
        Aggiungi a "<span data-confirm-name>${escape(boards[0].name)}</span>"
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedId = boards[0].id;
  const items = overlay.querySelectorAll('.cal-board-item');
  items.forEach(it => {
    it.addEventListener('click', () => {
      items.forEach(x => {
        x.classList.remove('sel');
        x.querySelector('.cal-board-check')?.remove();
      });
      it.classList.add('sel');
      it.insertAdjacentHTML('beforeend', `<span class="cal-board-check">${svg.check}</span>`);
      selectedId = it.dataset.boardId;
      const b = boards.find(b => b.id === selectedId);
      overlay.querySelector('[data-confirm-name]').textContent = b.name;
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector('.cal-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector('[data-confirm]').addEventListener('click', () => {
    close();
    sendEventToBoard(event, selectedId);
  });
}

// ── Event → post-it on board ───────────────────────────────────────
function eventToNoteText(e) {
  const start = new Date(e.startAt);
  const end   = new Date(e.endAt);
  const dateLine = `${DAY_NAMES_SHORT[(start.getDay() + 6) % 7]} ${start.getDate()} ${MONTH_NAMES[start.getMonth()].slice(0,3).toLowerCase()} · ${fmtTime(e.startAt)}–${fmtTime(e.endAt)}`;
  const lines = [
    `📅 ${e.title}`,
    dateLine,
  ];
  if (e.location) lines.push(`📍 ${e.location}`);
  return lines.join('\n');
}

function sendEventToBoard(event, boardId) {
  // Switch to that board if it's not the active one
  if (state.activeBoardId !== boardId) {
    const target = state.boards.find(b => b.id === boardId);
    if (target) {
      state.activeBoardId = boardId;
      state.notes = JSON.parse(JSON.stringify(target.notes || []));
      state.strokes = JSON.parse(JSON.stringify(target.strokes || []));
    }
  }

  // Build the note (centered on the visible viewport)
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = Math.round(-state.panX + (vw / 2) - 120);
  const cy = Math.round(-state.panY + (vh / 2) - 100);
  const note = {
    id: uid(),
    text: eventToNoteText(event),
    color: 'green', // calendar-origin notes default to sage to suggest origin
    x: Math.max(4, Math.min(state.boardW - 244, cx)),
    y: Math.max(4, Math.min(state.boardH - 204, cy)),
    w: 240, h: 200,
    rot: +(Math.random() * 4 - 2).toFixed(1),
    textColor: '#1A1714',
    fontSize: 14,
    noteStrokes: [],
    fromCalendar: true,
    calendarEventId: event.id,
    updatedAt: Date.now(),
  };
  state.notes.push(note);
  save();

  // Mark event as sent so the badge appears on subsequent renders
  event.onBoard = true;

  // Switch to board mode and render
  setActive(false);
  renderNotes();
  try { broadcastNoteUpsert(note); } catch {}

  showToast(`Aggiunto a "${state.boards.find(b => b.id === boardId)?.name || 'board'}"`, 'ok');
}

// ── Toast helper ────────────────────────────────────────────────────
function showToast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `cal-toast cal-toast-${kind}`;
  t.innerHTML = `${kind === 'ok' ? svg.check : ''}<span>${escape(msg)}</span>`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('on'), 16);
  setTimeout(() => t.classList.remove('on'), 2200);
  setTimeout(() => t.remove(), 2600);
}

// ── Active state + main render ─────────────────────────────────────
export async function setActive(on) {
  calState.active = on;
  document.body.classList.toggle('cal-mode', on);
  closeEventPopover();
  if (!on) return;
  // Render immediately with whatever we have (mock or last fetch),
  // then fetch fresh if the user has connected accounts.
  renderCalendar();
  if (getCurrentUser()) {
    await loadConnections();
    await loadEvents();
    if (calState.active) renderCalendar();
  }
}

export function isActive() { return calState.active; }

function renderEmptyState() {
  const signedIn = !!getCurrentUser();
  return `
    <div class="cal-empty">
      <div class="cal-empty-card">
        <div class="cal-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#1A6B5A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </div>
        <div class="cal-empty-title">Connetti il tuo calendario</div>
        <div class="cal-empty-sub">${signedIn
          ? 'Vedi tutti i tuoi appuntamenti qui e portali sulla board con un click.'
          : 'Accedi prima con Google sul drawer in alto a destra, poi connetti il tuo calendario.'}</div>
        ${signedIn ? `
          <button class="cal-empty-cta" data-cal-connect="google">
            ${svg.google || ''}
            <span>Connetti Google Calendar</span>
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

function renderConnectionChips() {
  if (!calState.connections.length) return '';
  return `
    <div class="cal-conns">
      ${calState.connections.map(c => `
        <span class="cal-conn-chip" title="${escape(c.account_email)}">
          <span class="cal-conn-dot" style="background:${escape(c.display_color || '#1A6B5A')}"></span>
          <span class="cal-conn-email">${escape(c.account_email)}</span>
        </span>
      `).join('')}
    </div>
  `;
}

function renderCalendar() {
  const root = dom.calendarView;
  if (!root) return;
  const showEmpty = (calState.source === 'empty' || (calState.events.length === 0 && getCurrentUser() && calState.connections.length === 0));
  root.innerHTML = `
    <div class="cal-header">
      ${renderHeader()}
    </div>
    ${renderConnectionChips()}
    <div class="cal-body cal-body-${calState.view}">
      ${showEmpty ? renderEmptyState() : (
        calState.view === 'day'   ? renderDay()   :
        calState.view === 'week'  ? renderWeek()  :
        calState.view === 'month' ? renderMonth() : ''
      )}
    </div>
  `;

  // Wire interactions
  root.querySelectorAll('[data-cal-view]').forEach(b => {
    b.addEventListener('click', () => { calState.view = b.dataset.calView; renderCalendar(); });
  });
  root.querySelectorAll('[data-cal-nav]').forEach(b => {
    b.addEventListener('click', () => navigate(b.dataset.calNav));
  });
  root.querySelector('[data-cal-back]')?.addEventListener('click', () => {
    if (_onLeave) _onLeave();
  });
  root.querySelectorAll('[data-cal-connect]').forEach(b => {
    b.addEventListener('click', () => connectGoogle());
  });
  root.querySelectorAll('.cal-event, .cal-mevent').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openEventPopover(el.dataset.eventId, el);
    });
  });
  root.querySelectorAll('.cal-mcell').forEach(el => {
    el.addEventListener('dblclick', () => {
      calState.cursor = new Date(el.dataset.calDay);
      calState.view   = 'day';
      renderCalendar();
    });
  });

  // Auto-scroll the day/week timeline near "now" so the user lands on
  // the relevant slot rather than 07:00.
  if (calState.view === 'day' || calState.view === 'week') {
    requestAnimationFrame(() => {
      const body = root.querySelector('.cal-body');
      if (!body) return;
      const now = new Date();
      const targetH = Math.max(START_H, now.getHours() - 1);
      body.scrollTop = (targetH - START_H) * HOUR_PX;
    });
  }
}

function navigate(action) {
  const v = calState.view;
  if (action === 'today') {
    calState.cursor = new Date();
  } else {
    const dir = action === 'prev' ? -1 : 1;
    if (v === 'day')   calState.cursor = addDays(calState.cursor, dir);
    if (v === 'week')  calState.cursor = addDays(calState.cursor, dir * 7);
    if (v === 'month') calState.cursor = addMonths(calState.cursor, dir);
  }
  renderCalendar();
}

// ── Public init ─────────────────────────────────────────────────────
export function initCalendar() {
  // Re-render every minute so the "now" line keeps moving.
  setInterval(() => {
    if (calState.active && (calState.view === 'day' || calState.view === 'week')) {
      const line = document.querySelector('.cal-nowline');
      if (line) {
        const now = new Date();
        const top = ((now.getHours() - START_H) * 60 + now.getMinutes()) * (HOUR_PX / 60);
        line.style.top = top + 'px';
        const ts = line.querySelector('.cal-nowline-time');
        if (ts) ts.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      }
    }
  }, 60_000);
}
