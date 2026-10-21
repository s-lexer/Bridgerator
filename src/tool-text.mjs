// LOGIC: see critical-logic/bridge.md ("Tool descriptions"). The engine's own tool descriptions are long
// and imperative (IMPORTANT / ALWAYS / MUST, caps): they cost tokens on every request and make ChatGPT's
// safety layer flag the app ("suspicious instruction"). The bridge sends these short, plain ones
// instead; names, schemas and annotations stay the engine's. A tool missing here keeps its debranded
// engine text (a new engine version still works).
const SHARED = ' Other chats may use this PC at the same time: re-read a file right before changing it.';
export const SHORT = {
  get_config: 'Shows this PC\'s engine settings: allowed folders, blocked commands, default shell, line limits and system info.',
  read_file: 'Reads a local file. Text: offset/length in lines (negative offset = last lines). Excel: sheet and range like "A1:D100". PDF: text by pages. DOCX: an outline by default; offset ≥ 1 gives the raw XML for edit_block. Images come back viewable. Use absolute paths.',
  read_multiple_files: 'Reads several files at once (text and images); a failed file does not stop the others. Use absolute paths.',
  write_file: `Writes a file: mode "rewrite" (default) or "append". Long files are best written in parts of about 30 lines (first rewrite, then append). Excel: a JSON 2D array or {"Sheet": [[...]]}. A new .docx can be written from markdown-style text; edit existing .docx with edit_block. Previous content is kept for Undo.${SHARED}`,
  create_directory: 'Creates a folder, including missing parent folders.',
  list_directory: 'Lists a folder with [FILE] / [DIR] marks; depth sets how many levels (default 2, nested folders show up to 100 items).',
  move_file: `Moves or renames a file or folder. It can be undone (bridgerator_undo).${SHARED}`,
  start_search: 'Starts a background search and returns a session id. searchType "files" matches names, "content" searches inside files; literalSearch for exact text with special characters; filePattern like "*.js". Read results with get_more_search_results.',
  get_more_search_results: 'Returns results of a search started with start_search; offset/length page through them (negative offset = last results).',
  stop_search: 'Stops a running search; its results stay readable for a few minutes.',
  list_searches: 'Lists running searches with their ids and status.',
  get_file_info: 'File or folder details: size, dates, type; line counts for text files, sheets for Excel files.',
  edit_block: `Edits a file in place. Text and DOCX: replaces old_string with new_string (one match unless expected_replacements says more; include a few lines of context). Excel: range like "Sheet1!A1:C10" with content as a 2D array. Previous content is kept for Undo.${SHARED}`,
  start_process: 'Runs a command or program in a terminal session on this PC (PowerShell by default; shell can be "cmd"). Returns the output, or the session pid when it keeps running. Follow up with read_process_output or interact_with_process. Simple delete commands move files to the Recycle Bin.',
  read_process_output: 'Reads new output from a running session (offset/length in lines; negative offset = last lines) and shows whether it waits for input or has finished.',
  interact_with_process: 'Sends input to a running session or REPL (pid from start_process) and returns the new output.',
  force_terminate: 'Stops a terminal session started with start_process.',
  list_sessions: 'Lists terminal sessions: pid, whether one waits for input, how long it runs.',
  list_processes: 'Lists running programs with pid, CPU and memory.',
  kill_process: 'Ends a running program by pid.',
  get_prompts: 'Returns a ready-made task prompt by id (action "get_prompt").',
};

// Our own tools: hints for the client (the relay passes them as they are).
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
export const OWN_ANNOTATIONS = {
  queue_list: RO, queue_next: RW, queue_update: RW, queue_add: RW, queue_edit: RW, queue_reorder: RW, queue_clear: DESTRUCTIVE,
  bridgerator_setup: RW, bridgerator_settings: RW, request_confirm_off: RW, confirm_on: RW, bridgerator_undo: DESTRUCTIVE,
};

/** Tool (debranded) → the short description; annotations kept, ours added. */
export function shorten(t) {
  const d = SHORT[t.name];
  const ann = t.annotations || OWN_ANNOTATIONS[t.name];
  return { ...t, ...(d ? { description: d } : {}), ...(ann ? { annotations: ann } : {}) };
}
