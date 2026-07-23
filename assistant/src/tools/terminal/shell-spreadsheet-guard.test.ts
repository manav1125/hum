import { describe, expect, test } from "bun:test";

import { detectsSpreadsheetBuild } from "./shell.js";

// The live failure this guards: the brain shells out to openpyxl/pandas to
// build an .xlsx instead of calling spreadsheet_create, producing a
// download-only file and a storm of per-command approval prompts.
describe("detectsSpreadsheetBuild", () => {
  test.each([
    'python3 -c "import openpyxl; wb = openpyxl.Workbook(); wb.save(\'budget.xlsx\')"',
    "python3 - <<'PY'\nimport pandas as pd\npd.DataFrame({'a':[1]}).to_excel('out.xlsx')\nPY",
    "pip install xlsxwriter && python build.py",
    "node -e \"const ExcelJS = require('exceljs'); new ExcelJS.Workbook()\"",
    "soffice --headless --convert-to xlsx budget.csv",
    "libreoffice --convert-to=xlsx data.csv",
    "python3 -c \"import zipfile; zipfile.ZipFile('x.xlsx','w')\"",
  ])("blocks hand-built xlsx: %s", (cmd) => {
    expect(detectsSpreadsheetBuild(cmd)).toBe(true);
  });

  test.each([
    "ls -la ~/Downloads/*.xlsx",
    "echo 'making a spreadsheet' && date",
    "cat report.txt",
    "git status",
    "python3 -c \"print('hello')\"",
  ])("allows unrelated command: %s", (cmd) => {
    expect(detectsSpreadsheetBuild(cmd)).toBe(false);
  });
});
