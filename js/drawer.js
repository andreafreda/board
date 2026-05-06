// ════════════════════════════════════════════════════════════════════
//   drawer.js — side drawer (board list, presets, actions, popup)
// ════════════════════════════════════════════════════════════════════
// Big chunk of UI: the right-hand drawer, the per-board controls
// (rename / duplicate / delete / public-private toggle / share link),
// the resolution presets row, and the bottom action buttons.

import { dom } from './dom.js';
import {
  state, save, syncActiveBoard, loadBoardIntoState, mkBoard, uid, clone,
  PRESETS,
} from './state.js';
import {
  applyBoardSize, centerBoard,
  redrawBoard,
} from './board.js';
import {
  renderNotes, deactivateNote, getActiveNote,
  setShowConfirm,
} from './notes.js';
import { syncCollabChannel } from './collab.js';
import { broadcastBoardSize } from './realtime.js';

// ── Auth bridge (set by auth.js) ────────────────────────────────────
let _authHooks = {
  getCurrentUser: () => null,
  sbCreateBoard:    () => {},
  sbDeleteBoard:    () => {},
  sbUpdateBoardName: () => {},
  sbUpdateVisibility: () => {},
  // Members CRUD (commit 1: cooperative)
  sbListMembers:       async () => [],
  sbAddMember:         async () => {},
  sbUpdateMemberRole:  async () => {},
  sbRemoveMember:      async () => {},
  // GDPR
  sbExportAllMyData:   async () => null,
  sbDeleteAllMyData:   async () => {},
};
export function setAuthHooks(h) { _authHooks = { ..._authHooks, ...h }; }

// ════════════════════════════════════════════════════════════════════
//   Drawer open/close
// ════════════════════════════════════════════════════════════════════
export function openDrawer(force) {
  const open = force ?? !dom.drawer.classList.contains('open');
  dom.drawer.classList.toggle('open', open);
  if (dom.drawerBackdrop) dom.drawerBackdrop.classList.toggle('on', open);
}

export function initDrawer() {
  dom.hamburger.addEventListener('click', () => openDrawer());
  if (dom.boardPill) dom.boardPill.addEventListener('click', () => openDrawer());
  if (dom.drawerBackdrop) dom.drawerBackdrop.addEventListener('click', () => openDrawer(false));

  // v2.0: two inline close X buttons — one next to the Google button (guests),
  // one next to the user-card (signed-in). Same handler.
  if (dom.drawerCloseBtn) dom.drawerCloseBtn.addEventListener('click', () => openDrawer(false));
  const closeGuest = document.getElementById('drawerCloseGuest');
  if (closeGuest) closeGuest.addEventListener('click', () => openDrawer(false));

  // v2.0: dimensioni-board popover — toggle from the toolbar button.
  const bsBtn  = document.getElementById('boardSizeBtn');
  const bsPop  = document.getElementById('boardSizePop');
  const frameToggle = document.getElementById('boardFrameToggle');
  const setBsOpen = (open) => {
    if (!bsPop) return;
    bsPop.hidden = !open;
    bsBtn?.classList.toggle('on', open);
    if (open) renderPresets();
  };
  if (bsBtn && bsPop) {
    bsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setBsOpen(bsPop.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!bsPop.hidden && !bsPop.contains(e.target) && e.target !== bsBtn) setBsOpen(false);
    });
  }
  // Frame visibility toggle — persisted on body class so CSS can react.
  if (frameToggle) {
    const FRAME_KEY = 'board-lite-frame-on';
    const initial = localStorage.getItem(FRAME_KEY) !== '0';
    document.body.classList.toggle('frame-on', initial);
    frameToggle.classList.toggle('on', initial);
    frameToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const on = !document.body.classList.contains('frame-on');
      document.body.classList.toggle('frame-on', on);
      frameToggle.classList.toggle('on', on);
      localStorage.setItem(FRAME_KEY, on ? '1' : '0');
    });
  }

  // v2.0: top-right share button — copies the active board's share URL.
  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) {
    let resetTimer = null;
    const flashOk = () => {
      shareBtn.classList.add('copied');
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => shareBtn.classList.remove('copied'), 1600);
    };
    const fallback = (link) => {
      // execCommand fallback for non-secure contexts; if all else fails, prompt
      try {
        const ta = document.createElement('textarea');
        ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { flashOk(); return; }
      } catch {}
      prompt('Share link:', link);
    };
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = state.activeBoardId;
      if (!id) { alert('Apri prima una board da condividere.'); return; }
      const link = `${location.origin}${location.pathname}?board=${id}`;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(link).then(flashOk, () => fallback(link));
      } else {
        fallback(link);
      }
    });
  }

  // Mirror document.title into the board-name pill so it always reflects
  // the active board without having to thread state through every caller.
  const titleEl = document.querySelector('title');
  const sync = () => {
    const t = (document.title || 'Board').replace(/ · Board$/, '');
    if (dom.boardPillName) dom.boardPillName.textContent = t;
    if (dom.boardPill) dom.boardPill.classList.add('on');
  };
  sync();
  if (titleEl) new MutationObserver(sync).observe(titleEl, { childList: true });
}

// ════════════════════════════════════════════════════════════════════
//   Confirm popup (used by notes + board delete)
// ════════════════════════════════════════════════════════════════════
let pendingDelete = null;

export function showConfirm(anchorEl, onConfirm, msg) {
  dom.confirmMsg.textContent = msg || 'Eliminare il post-it?';
  pendingDelete = onConfirm;
  const r = anchorEl.getBoundingClientRect();
  const popW = 210, margin = 8;
  let left = r.right - popW;
  let top  = r.bottom + margin;
  if (left < 8) left = 8;
  if (top + 100 > window.innerHeight) top = r.top - 100 - margin;
  dom.confirmPop.style.left = left + 'px';
  dom.confirmPop.style.top  = top  + 'px';
  dom.confirmPop.classList.add('open');
}

function hideConfirm() {
  dom.confirmPop.classList.remove('open');
  pendingDelete = null;
}

export function initConfirmPopup() {
  dom.confirmYes.addEventListener('click', () => {
    if (pendingDelete) { pendingDelete(); hideConfirm(); }
  });
  dom.confirmNo.addEventListener('click', hideConfirm);
  document.addEventListener('click', (e) => {
    if (dom.confirmPop.classList.contains('open') && !dom.confirmPop.contains(e.target)) {
      hideConfirm();
    }
  }, { capture: true });

  // Wire notes.js so it can call our showConfirm
  setShowConfirm(showConfirm);
}

// ════════════════════════════════════════════════════════════════════
//   Board list
// ════════════════════════════════════════════════════════════════════
export function renderBoardList() {
  const listEl = dom.boardsList;
  if (!listEl) return;

  const isUser = !!_authHooks.getCurrentUser();
  if (dom.newBoardBtn) dom.newBoardBtn.style.display = isUser ? 'flex' : 'none';
  if (dom.gdprSection) dom.gdprSection.style.display = isUser ? '' : 'none';
  const footer = document.getElementById('drawerFooter');
  if (footer) footer.style.display = isUser ? 'flex' : 'none';

  listEl.innerHTML = '';

  if (!isUser) {
    // Guest: show the active board as a single read-only entry
    const b = state.boards.find((b) => b.id === state.activeBoardId) || state.boards[0];
    if (b) {
      const item = document.createElement('div');
      item.className = 'd-board local active';
      const dot = document.createElement('div'); dot.className = 'd-dot';
      const name = document.createElement('span');
      name.className = 'd-bname';
      name.textContent = b.name; name.title = b.name;
      item.append(dot, name);
      listEl.appendChild(item);
    }
    return;
  }

  // Visibility cycle: private → public → cooperative → private
  const VIS_CYCLE = { private: 'public', public: 'cooperative', cooperative: 'private' };
  const VIS_ICON  = { private: '🔒', public: '🌐', cooperative: '👥' };
  const VIS_TITLE = {
    private: 'Privato — click per condividere via link',
    public:  'Pubblico (link sola lettura) — click per cooperativa',
    cooperative: 'Cooperativa (membri editor) — click per privato',
  };

  // Render a single board entry (used by both sections)
  const renderEntry = (b) => {
    if (!b.visibility) b.visibility = 'private';
    const isActive    = b.id === state.activeBoardId;
    const isMine      = (b.myRole || 'owner') === 'owner';
    const isShareable = b.visibility === 'public' || b.visibility === 'cooperative';
    const ownedCount  = state.boards.filter((bd) => (bd.myRole || 'owner') === 'owner').length;

    const item = document.createElement('div');
    item.className = 'd-board' + (isActive ? ' active' : '');
    item.addEventListener('click', () => switchBoard(b.id));

    const dot  = document.createElement('div'); dot.className = 'd-dot';
    const name = document.createElement('span');
    name.className = 'd-bname';
    name.textContent = b.name; name.title = b.name;

    let visBtn;
    if (isMine) {
      visBtn = document.createElement('button');
      visBtn.type = 'button';
      visBtn.className = 'vis-btn' + (b.visibility !== 'private' ? ' pub' : '');
      visBtn.textContent = VIS_ICON[b.visibility];
      visBtn.title = VIS_TITLE[b.visibility];
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newVis = VIS_CYCLE[b.visibility];
        b.visibility = newVis;
        save();
        _authHooks.sbUpdateVisibility?.(b.id, newVis);
        renderBoardList();
        // If we just toggled the ACTIVE board into/out of cooperative,
        // open or close the realtime channel accordingly.
        if (b.id === state.activeBoardId) syncCollabChannel();
      });
    } else {
      visBtn = document.createElement('span');
      visBtn.className = 'vis-btn pub';
      visBtn.textContent = b.myRole === 'editor' ? '✏️' : '👁';
      visBtn.title = b.myRole === 'editor' ? 'Membro editor' : 'Membro viewer';
    }

    const acts = document.createElement('div'); acts.className = 'd-acts';
    if (isMine) {
      const mkbib = (icon, cls, title, cb) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'd-bib ' + cls;
        btn.title = title;
        btn.textContent = icon;
        btn.addEventListener('click', (e) => { e.stopPropagation(); cb(btn); });
        return btn;
      };
      acts.append(
        mkbib('✏️', '', 'Rename',    () => startRenameBoard(b, name)),
        mkbib('⧉',  '', 'Duplicate', () => dupBoard(b)),
        ...(ownedCount > 1
            ? [mkbib('✕', 'del', 'Delete', (btn) => confirmDeleteBoard(b.id, btn))]
            : []),
      );
    }

    item.append(dot, name, visBtn, acts);
    listEl.appendChild(item);

    // Share-link row + members panel — owner-only
    if (isMine && isShareable) {
      const shareRow = document.createElement('div');
      shareRow.className = 'd-share-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'd-copy-btn';
      copyBtn.title = 'Copy share link';
      copyBtn.innerHTML = '🔗';
      let copyTimer = null;
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const link = `${location.origin}${location.pathname}?board=${b.id}`;
        navigator.clipboard.writeText(link).then(() => {
          copyBtn.innerHTML = '✓';
          copyBtn.classList.add('copied');
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => {
            copyBtn.innerHTML = '🔗';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch(() => prompt('Share link:', link));
      });
      shareRow.appendChild(copyBtn);
      listEl.appendChild(shareRow);

      if (b.visibility === 'cooperative' && isActive) {
        listEl.appendChild(buildMembersPanel(b));
      }
    }
  };

  // Section header helper — v2.0 uses an icon + horizontal rule instead of
  // a text label, mirroring the prototype's icon-first sectioning.
  const SECTION_ICONS = {
    mine:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    shared: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };
  const renderHeader = (kind, title) => {
    const h = document.createElement('div');
    h.className = 'd-section-hdr';
    h.title = title;
    h.innerHTML = `${SECTION_ICONS[kind]}<span class="d-section-rule"></span>`;
    listEl.appendChild(h);
  };

  // Split into "mine" vs "shared with me" (cooperative member, not owner)
  const ownBoards    = state.boards.filter((b) => (b.myRole || 'owner') === 'owner');
  const sharedBoards = state.boards.filter((b) => b.myRole && b.myRole !== 'owner');

  if (ownBoards.length) {
    renderHeader('mine', 'Le tue board');
    ownBoards.forEach(renderEntry);
  }
  if (sharedBoards.length) {
    renderHeader('shared', 'Condivise con te');
    sharedBoards.forEach(renderEntry);
  }
}

// ── Members panel (cooperative boards, owner-only) ──────────────────
function buildMembersPanel(board) {
  const wrap = document.createElement('div');
  wrap.className = 'd-members';
  wrap.style.cssText = 'padding:.25rem .35rem .35rem;display:flex;flex-direction:column;gap:.3rem;';
  wrap.addEventListener('click', (e) => e.stopPropagation());

  // Add row
  const addRow = document.createElement('div');
  addRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const inp = document.createElement('input');
  inp.type = 'email';
  inp.placeholder = 'email membro…';
  inp.style.cssText = 'flex:1;font-size:.78rem;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = '+';
  addBtn.style.cssText = 'width:26px;height:26px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:.95rem;font-weight:700;';
  addBtn.addEventListener('click', async () => {
    const email = inp.value.trim().toLowerCase();
    if (!email) return;
    try {
      await _authHooks.sbAddMember(board.id, email, 'editor');
      inp.value = '';
      refresh();
    } catch (err) { alert('Errore: ' + err.message); }
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
  addRow.append(inp, addBtn);
  wrap.appendChild(addRow);

  // Members list (loaded async)
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  wrap.appendChild(list);

  async function refresh() {
    list.innerHTML = '<div style="font-size:.7rem;opacity:.55;">caricamento…</div>';
    const members = await _authHooks.sbListMembers(board.id);
    list.innerHTML = '';
    if (!members.length) {
      list.innerHTML = '<div style="font-size:.7rem;opacity:.55;">Nessun membro invitato</div>';
      return;
    }
    members.forEach((m) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:.74rem;';
      const em = document.createElement('span');
      em.textContent = m.email; em.title = m.email;
      em.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

      const roleSel = document.createElement('select');
      roleSel.style.cssText = 'font-size:.7rem;padding:2px 4px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);';
      ['editor','viewer'].forEach((r) => {
        const o = document.createElement('option');
        o.value = r; o.textContent = r === 'editor' ? '✏️ editor' : '👁 viewer';
        if (r === m.role) o.selected = true;
        roleSel.appendChild(o);
      });
      roleSel.addEventListener('change', async () => {
        try { await _authHooks.sbUpdateMemberRole(board.id, m.email, roleSel.value); }
        catch (err) { alert('Errore: ' + err.message); refresh(); }
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Rimuovi';
      rmBtn.style.cssText = 'width:20px;height:20px;border:none;background:transparent;color:var(--muted);font-size:.7rem;cursor:pointer;border-radius:4px;';
      rmBtn.addEventListener('mouseenter', () => rmBtn.style.color = 'var(--danger)');
      rmBtn.addEventListener('mouseleave', () => rmBtn.style.color = 'var(--muted)');
      rmBtn.addEventListener('click', async () => {
        if (!confirm('Rimuovere ' + m.email + '?')) return;
        try { await _authHooks.sbRemoveMember(board.id, m.email); refresh(); }
        catch (err) { alert('Errore: ' + err.message); }
      });

      row.append(em, roleSel, rmBtn);
      list.appendChild(row);
    });
  }
  refresh();

  return wrap;
}

// ── Per-board operations ────────────────────────────────────────────
function startRenameBoard(board, nameEl) {
  const orig = board.name;
  const inp = document.createElement('input');
  inp.className = 'd-binp';
  inp.value = orig;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  // v2.0.24: don't let clicks/mousedowns bubble up to the parent row,
  // whose handler would call switchBoard() and tear down the rename
  // input the moment the user tries to position their cursor inside it.
  ['click','mousedown','pointerdown'].forEach((evName) => {
    inp.addEventListener(evName, (e) => e.stopPropagation());
  });
  const done = () => {
    board.name = inp.value.trim() || orig;
    nameEl.textContent = board.name;
    nameEl.title = board.name;
    inp.replaceWith(nameEl);
    if (board.id === state.activeBoardId) document.title = board.name;
    save();
    _authHooks.sbUpdateBoardName?.(board.id, board.name);
  };
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = orig; inp.blur(); }
  });
}

function switchBoard(id) {
  if (id === state.activeBoardId) { openDrawer(false); return; }
  if (getActiveNote()) deactivateNote();
  syncActiveBoard();
  state.activeBoardId = id;
  const b = state.boards.find((b) => b.id === id);
  loadBoardIntoState(b);
  applyBoardSize(b.width, b.height);
  renderBoardList(); renderPresets();
  openDrawer(false);
  save();
  syncCollabChannel();
}

function newBoard() {
  if (getActiveNote()) deactivateNote();
  syncActiveBoard();
  const b = mkBoard();
  state.boards.push(b);
  state.activeBoardId = b.id;
  loadBoardIntoState(b);
  applyBoardSize(b.width, b.height);
  renderBoardList(); renderPresets();
  save();
  _authHooks.sbCreateBoard?.(b);
  syncCollabChannel();
}

function dupBoard(board) {
  if (board.id === state.activeBoardId) syncActiveBoard();
  const dup = clone(board);
  dup.id = uid();
  dup.notes = dup.notes.map((n) => ({ ...n, id: uid() }));
  // Duplicates start private — sharing must be re-enabled deliberately
  dup.visibility = 'private';
  state.boards.push(dup);
  // Switch to the new duplicate so the user sees what they just created
  state.activeBoardId = dup.id;
  loadBoardIntoState(dup);
  applyBoardSize(dup.width, dup.height);
  renderBoardList(); renderPresets();
  save();
  _authHooks.sbCreateBoard?.(dup);
  syncCollabChannel();
}

function confirmDeleteBoard(boardId, anchorEl) {
  const b = state.boards.find((bd) => bd.id === boardId);
  showConfirm(anchorEl, () => execDeleteBoard(boardId), `Delete "${b?.name || 'board'}"?`);
}

function execDeleteBoard(boardId) {
  const idx = state.boards.findIndex((b) => b.id === boardId);
  if (idx < 0) return;
  state.boards.splice(idx, 1);
  if (state.activeBoardId === boardId) {
    if (getActiveNote()) deactivateNote();
    const nb = state.boards[Math.min(idx, state.boards.length - 1)];
    state.activeBoardId = nb.id;
    loadBoardIntoState(nb);
    applyBoardSize(nb.width, nb.height);
  }
  renderBoardList(); renderPresets(); save();
  _authHooks.sbDeleteBoard?.(boardId);
  syncCollabChannel();
}

// ════════════════════════════════════════════════════════════════════
//   Resolution presets + size inputs
// ════════════════════════════════════════════════════════════════════
// v2.0: device-card preset renderer for the dimensioni-board popover.
const PRESET_ICONS = {
  desktop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="4" width="20" height="13" rx="1.2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  laptop:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="1"/><path d="M2 20h20"/></svg>',
  tv:      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="5" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
  tablet:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
  mobile:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
};
export function renderPresets() {
  const row = dom.presetRow;
  if (!row) return;
  row.innerHTML = '';
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = p.title || p.label;
    const isActive = Number(state.boardW) === p.w && Number(state.boardH) === p.h;
    b.className = 'preset-card' + (isActive ? ' active' : '');
    // v2.0.16: icon-only preset cards. The full title still lives on the
    // tooltip, and the W×H inputs below show the exact numbers.
    b.innerHTML = PRESET_ICONS[p.kind] || PRESET_ICONS.desktop;
    b.addEventListener('click', () => {
      dom.boardW.value = p.w;
      dom.boardH.value = p.h;
      applyBoardSize(p.w, p.h);
      renderPresets(); save();
      broadcastBoardSize(p.w, p.h);
    });
    row.appendChild(b);
  });
  if (dom.boardW) dom.boardW.value = state.boardW;
  if (dom.boardH) dom.boardH.value = state.boardH;
}

function initSizeButtons() {
  dom.applySize.addEventListener('click', () => {
    const w = Math.max(400, Math.min(4000, parseInt(dom.boardW.value) || 1366));
    const h = Math.max(300, Math.min(3000, parseInt(dom.boardH.value) || 768));
    applyBoardSize(w, h);
    renderPresets(); save();
    openDrawer(false);
    broadcastBoardSize(w, h);
  });
  dom.centerBoard.addEventListener('click', () => {
    centerBoard();
    openDrawer(false);
  });
}

// ════════════════════════════════════════════════════════════════════
//   Bottom actions: clear sketch / reset board / export / import
// ════════════════════════════════════════════════════════════════════
function initActionButtons() {
  dom.clearSketch.addEventListener('click', () => {
    state.strokes = [];
    redrawBoard(); save();
    openDrawer(false);
  });

  dom.resetBtn.addEventListener('click', (e) => {
    showConfirm(e.currentTarget, () => {
      if (getActiveNote()) deactivateNote();
      state.notes = []; state.strokes = [];
      renderNotes(); redrawBoard();
      save();
      openDrawer(false);
    }, 'Clear all notes and drawings?');
  });

  // New-board button (logged-in only — visibility is toggled in renderBoardList)
  dom.newBoardBtn?.addEventListener('click', (e) => { e.stopPropagation(); newBoard(); });

  // Export
  dom.exportBtn.addEventListener('click', () => {
    syncActiveBoard();
    const b = state.boards.find((bd) => bd.id === state.activeBoardId);
    const out = { name: b.name, width: b.width, height: b.height, notes: b.notes, strokes: b.strokes };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    a.href = url;
    a.download = `board-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
    openDrawer(false);
  });

  // Import
  dom.importFile.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imp = JSON.parse(ev.target.result);
        if (typeof imp !== 'object' || !imp.notes) throw new Error('formato non valido');

        // v2.0.17: never overwrite the currently-open board on import.
        // Build a brand-new board from the file and switch to it, so the
        // user's existing work stays untouched.
        if (getActiveNote()) deactivateNote();
        syncActiveBoard();

        const b = mkBoard({
          name:   (imp.name ? imp.name + ' (import)' : 'Imported board'),
          width:  imp.width  || 1366,
          height: imp.height || 768,
        });
        // mkBoard returns a fresh board with empty notes/strokes —
        // overwrite those (and not its id / panX / panY) with the file
        // content. Notes/strokes are deep-cloned so the source object
        // can't be mutated later.
        b.notes   = clone(imp.notes   || []);
        b.strokes = clone(imp.strokes || []);

        state.boards.push(b);
        state.activeBoardId = b.id;
        loadBoardIntoState(b);
        applyBoardSize(b.width, b.height);
        renderBoardList(); renderPresets();
        save();
        _authHooks.sbCreateBoard?.(b);
        syncCollabChannel();

        openDrawer(false);
      } catch (err) {
        alert('Import fallito: ' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

// ── Privacy / GDPR buttons ──────────────────────────────────────────
function initGdprButtons() {
  dom.exportAllBtn?.addEventListener('click', async () => {
    dom.exportAllBtn.disabled = true;
    const orig = dom.exportAllBtn.textContent;
    dom.exportAllBtn.textContent = '… esporto …';
    try {
      const data = await _authHooks.sbExportAllMyData();
      if (!data) { alert('Nessun dato da esportare.'); return; }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
      a.href = url;
      a.download = `board-export-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      openDrawer(false);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Errore durante l\'esportazione: ' + (err?.message || err));
    } finally {
      dom.exportAllBtn.disabled = false;
      dom.exportAllBtn.textContent = orig;
    }
  });

  dom.deleteAccountBtn?.addEventListener('click', async () => {
    const confirm1 = window.confirm(
      'Eliminerai TUTTE le tue board, note, disegni e iscrizioni a board cooperative.\n' +
      'Questa azione è irreversibile.\n\n' +
      'Vuoi continuare?'
    );
    if (!confirm1) return;
    const typed = window.prompt(
      'Per conferma definitiva, digita ELIMINA (in maiuscolo) e premi OK:'
    );
    if (typed !== 'ELIMINA') {
      alert('Conferma annullata. Niente è stato cancellato.');
      return;
    }
    dom.deleteAccountBtn.disabled = true;
    dom.deleteAccountBtn.textContent = '… elimino …';
    try {
      await _authHooks.sbDeleteAllMyData();
      // The onAuthStateChange SIGNED_OUT handler will reset the UI
      // back to guest state automatically.
      try { localStorage.removeItem('board-lite-v10'); } catch {}
      try { localStorage.removeItem('board-lite-v10-prefs'); } catch {}
      alert('Account e dati eliminati. A presto.');
      // Reload to ensure a clean slate
      setTimeout(() => location.reload(), 300);
    } catch (err) {
      console.error('Delete failed:', err);
      alert('Errore durante l\'eliminazione: ' + (err?.message || err));
      dom.deleteAccountBtn.disabled = false;
      dom.deleteAccountBtn.textContent = '⚠️ Elimina account';
    }
  });
}

// ════════════════════════════════════════════════════════════════════
//   One-shot init
// ════════════════════════════════════════════════════════════════════
export function initDrawerActions() {
  initConfirmPopup();
  initSizeButtons();
  initActionButtons();
  initGdprButtons();
}
