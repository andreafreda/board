// ════════════════════════════════════════════════════════════════════
//   dom.js — single registry of every DOM element the app touches
// ════════════════════════════════════════════════════════════════════
// Looking up `document.getElementById` in dozens of places is noisy and
// makes refactors hard. Every reference lives here.

const $ = (id) => document.getElementById(id);

export const dom = {
  // Containers
  viewport:    $('viewport'),
  board:       $('board'),
  notesLayer:  $('notesLayer'),

  // Sketch canvas
  sketch:      $('sketch'),

  // Top-right corner buttons
  corner:      document.querySelector('.corner'),
  textModeBtn: $('textModeBtn'),
  drawModeBtn: $('drawModeBtn'),
  noteModeBtn: $('noteModeBtn'),
  hamburger:   $('hamburger'),

  // Drawer (hamburger menu)
  drawer:      $('drawer'),
  newBoardBtn: $('newBoardBtn'),
  boardsList:  $('boardsList'),
  presetRow:   $('presetRow'),
  boardW:      $('boardW'),
  boardH:      $('boardH'),
  applySize:   $('applySize'),
  centerBoard: $('centerBoard'),
  clockToggleBtn: $('clockToggleBtn'),
  clearSketch: $('clearSketch'),
  resetBtn:    $('resetBtn'),
  exportBtn:   $('exportBtn'),
  importFile:  $('importFile'),

  // Auth section in drawer
  guestRow:    $('authGuestRow'),
  userRow:     $('authUserRow'),
  avatarEl:    $('authAvatar'),
  userName:    $('authUserName'),
  googleBtn:   $('googleBtn'),
  logoutBtn:   $('authLogoutBtn'),

  // Toolbars (note / draw / text)
  noteToolbar: $('noteToolbar'),
  noteColors:  $('noteColors'),
  addNoteBtn:  $('addNoteBtn'),

  drawToolbar: $('drawToolbar'),
  penBtn:      $('penBtn'),
  eraserBtn:   $('eraserBtn'),
  penColors:   $('penColors'),
  drawSep2:    $('drawSep2'),
  drawSliderTrack:   $('drawSliderTrack'),
  drawSliderFill:    $('drawSliderFill'),
  drawSliderThumb:   $('drawSliderThumb'),
  drawSliderVal:     $('drawSliderVal'),
  drawSliderPreview: $('drawSliderPreview'),

  textToolbar: $('textToolbar'),
  txtColors:   $('txtColors'),
  txtSliderTrack:   $('txtSliderTrack'),
  txtSliderFill:    $('txtSliderFill'),
  txtSliderThumb:   $('txtSliderThumb'),
  txtSliderVal:     $('txtSliderVal'),
  txtSliderPreview: $('txtSliderPreview'),

  // Misc floating UI
  clockEl:    $('clock'),
  timeLine:   $('timeLine'),
  dateLine:   $('dateLine'),
  panInd:     $('panInd'),
  fullBtn:    $('fullBtn'),

  // View-mode banner (shared link)
  viewBanner:    $('viewBanner'),
  viewBoardName: $('viewBoardName'),
  viewExitBtn:   $('viewExitBtn'),

  // Peers (presence avatar stack on cooperative boards)
  peersStack:    $('peersStack'),

  // Confirm popup
  confirmPop:  $('confirmPop'),
  confirmMsg:  $('confirmMsg'),
  confirmYes:  $('confirmYes'),
  confirmNo:   $('confirmNo'),
};
