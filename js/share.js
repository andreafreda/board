// ════════════════════════════════════════════════════════════════════
//   share.js — fetch a public board and hand it to enterViewMode
// ════════════════════════════════════════════════════════════════════

import { enterViewMode } from './board.js';
import { getClient, sbLoadPublicBoard } from './db.js';

export async function loadPublicBoard(boardId) {
  try {
    const client = await getClient();
    const board  = await sbLoadPublicBoard(client, boardId);
    enterViewMode(board);
    return true;
  } catch (err) {
    console.warn('loadPublicBoard:', err.message);
    return false;
  }
}
