/**
 * Detects shell commands that hand-assemble a deliverable .xlsx workbook.
 *
 * This brain (DeepSeek-class over OpenRouter) unreliably follows the "load
 * spreadsheet-studio, call spreadsheet_create" routing in the tool
 * descriptions and instead shells out to openpyxl / pandas / xlsxwriter /
 * ExcelJS / LibreOffice / raw zip-XML — producing a download-only file that
 * won't open in the native viewer and firing a per-command approval prompt
 * for every install and step (the ~10-prompt storm the user hit). A tool
 * description can't enforce the routing; this detector lets both the approval
 * layer (deny before any prompt) and the shell tool (defense in depth) turn
 * the wrong path into a self-correcting routing signal, deterministically.
 */

const SPREADSHEET_BUILD_PATTERNS: RegExp[] = [
  /\bopenpyxl\b/i,
  /\bxlsxwriter\b/i,
  /\.to_excel\s*\(/i,
  /\bexceljs\b/i,
  /new\s+ExcelJS\b/i,
  /--convert-to[= ]+["']?xlsx/i,
  /\bwrite_xlsx\b/i,
  /\bwritexlsx\b/i,
];

export function detectsSpreadsheetBuild(command: string): boolean {
  if (SPREADSHEET_BUILD_PATTERNS.some((re) => re.test(command))) return true;
  // Raw-XML route: zipping an xl/ package into a .xlsx by hand.
  if (/\.xlsx\b/i.test(command) && /\bzipfile\b/i.test(command)) return true;
  return false;
}

export const SPREADSHEET_ROUTING_MESSAGE =
  "Do not build a spreadsheet/.xlsx with shell commands (openpyxl, pandas, " +
  "xlsxwriter, ExcelJS, LibreOffice, or raw XML). A hand-built file opens only " +
  "as a download, not in the native spreadsheet viewer, and each command " +
  "needlessly prompts the user for approval. Instead: call `skill_load` with " +
  'skill "spreadsheet-studio", then `skill_execute` the `spreadsheet_create` ' +
  "tool (pass `filename` and a `sheets` array of {name, rows}; use \"=\" " +
  "formulas for any derived cell). That delivers a real, openable workbook " +
  "with no per-command approvals.";
