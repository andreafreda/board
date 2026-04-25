# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Board Lite v10** — a single-file, zero-dependency HTML5 whiteboard app (`index.html`). No build step, no package manager, no framework. Open the file directly in a browser to run it.

## Architecture

Everything lives in one file: CSS custom properties for theming, HTML structure, and a self-invoking JS module `(()=>{ ... })()`.

**State model** — a single `state` object is persisted to `localStorage` under key `board-lite-v10`. On load, `DEF` defaults are merged with stored JSON. Every interaction ends with `save()`.

```
state = {
  drawMode, textMode, noteMode,       // mutually exclusive modes
  strokes[],                           // board-level drawing strokes
  notes[],                             // post-it notes
  boardW, boardH, panX, panY,         // board size and viewport pan
  penColor, penSize, eraser, eraserSize,
  noteColor, showClock
}
```

**Rendering layers** (stacked inside `#board`):
1. `#sketch` (`<canvas>`) — board-level freehand drawing (`state.strokes`)
2. `#notesLayer` — absolutely-positioned `.note` articles, each containing:
   - `.note-head` — drag handle + dup/delete buttons
   - `<textarea>` — editable text (pointer-events toggled by text mode)
   - `.note-canvas` — per-note freehand drawing (`note.noteStrokes`)
   - `.resize-handle` — SE corner resize

**Three exclusive modes** (toggled by corner buttons):
- **Draw mode** (`drawModeBtn`): activates sketch canvas and note canvases; shows draw toolbar with pen/eraser and vertical size slider.
- **Text mode** (`textModeBtn`): clicking a note's body activates it for editing; shows text toolbar with color and font-size slider.
- **Note mode** (`noteModeBtn`): shows note toolbar; `addNoteBtn` spawns a new post-it centered in the viewport.

**Pan system** — pointer events on `#viewport` (when not in draw/text mode) move the board via CSS `translate`. `clampPan()` keeps the board from scrolling entirely off-screen.

**Vertical slider** (`makeVSlider`) — reusable pointer-driven slider used for pen size and font size; `getValue`/`setValue` callbacks make it generic.

**Board size presets** — `PRESETS` array; selecting one calls `applyBoardSize(w, h)` which resizes the canvas, clamps notes, and re-renders everything.

**Export/Import** — full `state` serialized to JSON download; import validates presence of `notes` key before merging.

## Key constants

| Constant | Value |
|---|---|
| `KEY` | `'board-lite-v10'` (localStorage key) |
| `NOTE_COLORS` | 7 named colors mapped in `NOTE_COLOR_MAP` |
| `PEN_COLORS` | 8 hex colors including white |
| `TEXT_COLORS` | 7 hex colors |
| `PEN_MIN/MAX` | 1–40 |
| `ERASER_MIN/MAX` | 8–100 |
| `FONT_MIN/MAX` | 10–36 |

## Things to watch out for

- **DPR scaling**: both `#sketch` and `.note-canvas` use `window.devicePixelRatio` for crisp rendering. When resizing canvases, always call `ctx.setTransform(dpr,0,0,dpr,0,0)` after setting width/height.
- **Coordinate systems**: stroke points on `#sketch` use `sketch.getBoundingClientRect()` (already accounts for pan since the canvas is inside the translated board). Note canvases use their own `getBoundingClientRect()` the same way.
- **Mode exclusivity**: switching to any mode must disable the other two — see the pattern in each mode's click handler.
- **Eraser compositing**: eraser strokes use `globalCompositeOperation = 'destination-out'` with opaque black, then reset to `'source-over'`.
