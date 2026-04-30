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
};
export function setAuthHooks(h) { _authHooks = { ..._authHooks, ...h }; }

// ════════════════════════════════════════════════════════════════════
//   Drawer open/close
// ════════════════════════════════════════════════════════════════════
export function openDrawer(force) {
  const open = force ?? !dom.drawer.classList.contains('open');
  dom.drawer.classList.toggle('open', open);
}

export function initDrawer() {
  dom.hamburger.addEventListener('click', () => openDrawer());
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
  if (dom.newBoardBtn) dom.newBoardBtn.style.display = isUser ? 'grid' : 'none';

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

  // Section header helper
  const renderHeader = (text) => {
    const h = document.createElement('div');
    h.className = 'd-section-hdr';
    h.textContent = text;
    h.style.cssText = 'font-size:.66rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:.5rem .15rem .25rem;';
    listEl.appendChild(h);
  };

  // Split into "mine" vs "shared with me" (cooperative member, not owner)
  const ownBoards    = state.boards.filter((b) => (b.myRole || 'owner') === 'owner');
  const sharedBoards = state.boards.filter((b) => b.myRole && b.myRole !== 'owner');

  if (ownBoards.length) {
    renderHeader('Le tue board');
    ownBoards.forEach(renderEntry);
  }
  if (sharedBoards.length) {
    renderHeader('Condivise con te');
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
export function renderPresets() {
  const row = dom.presetRow;
  row.innerHTML = '';
  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.title = p.title || p.label;
    const isActive = Number(state.boardW) === p.w && Number(state.boardH) === p.h;
    b.className = 'preset-btn' + (isActive ? ' active' : '');
    b.style.cssText = 'font-size:1.3rem;padding:.3rem .5rem;';
    b.addEventListener('click', () => {
      dom.boardW.value = p.w;
      dom.boardH.value = p.h;
      applyBoardSize(p.w, p.h);
      renderPresets(); save();
      broadcastBoardSize(p.w, p.h);
    });
    row.appendChild(b);
  });
  dom.boardW.value = state.boardW;
  dom.boardH.value = state.boardH;
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
        state.notes   = imp.notes   || [];
        state.strokes = imp.strokes || [];
        if (imp.width) applyBoardSize(imp.width, imp.height || 768);
        else { renderNotes(); redrawBoard(); }
        syncActiveBoard(); save();
        renderPresets();
        openDrawer(false);
      } catch (err) {
        alert('Import fallito: ' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

// ════════════════════════════════════════════════════════════════════
//   One-shot init
// ════════════════════════════════════════════════════════════════════
export function initDrawerActions() {
  initConfirmPopup();
  initSizeButtons();
  initActionButtons();
}
