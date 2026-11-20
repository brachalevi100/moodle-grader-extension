# Moodle Grader Assistant (Chrome, Manifest V3)

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder (`moodle-grader-extension`).
3. Pin the extension. Clicking the icon opens the side panel.

## First run
In the side panel, click **בחירת תיקיית Solution** and select `C:\Users\ברכה\Desktop\Projects\Solution`
(the folder that contains `M_Week3`, `M_Week4`, …). You only do this once: the folder is stored in IndexedDB and restored every time the panel opens.
After a browser restart Chrome may drop the permission. The panel then shows **🔒 אישור גישה מחדש לתיקייה**. Click it once (choose "Allow on every visit") and everything reloads.

## Automatic discovery (`lib/discover.js`)
On load, and when you click **סריקה מחדש**, the extension scans the root folder:

```
Solution\                      ← root (chosen once)
└─ M_Week3\                    ← any folder matching M_Week<N> / MWeek<N> / M_Week_<N> / M_Week <N> (any case)
   └─ Solution\                ← any case; if missing, the week folder itself is used
      ├─ *.xlsx | *.xlsm       ← rubric workbook. With several: the one named "מחוון"/"rubric", else the newest
      ├─ *.docx                ← solution document
      └─ *.py                  ← solution scripts
```

- Excel/LibreOffice temp and lock files (`~$…`, `.~lock…`) are ignored.
- **Week** dropdown: it lists every discovered week. It's chosen automatically from the Moodle assignment title (`תרגיל בית 3`, `שבוע 3`, `Week 3`, …). If the title has no number, it uses the last week you picked, or else the highest week. You can always change it; your choice is remembered.
- The panel shows where the rubric came from, e.g. `M_Week3 → Solution → מערכות הפעלה - מחוון בדיקת תרגילי בית.xlsx`.
- If a week has no workbook, the panel says `לא נמצא קובץ XLSX בתיקיית M_Week3\Solution` and offers **בחירת קובץ מחוון ידנית…**. A manually picked file is remembered and used only when discovery finds nothing.
- If the root folder was moved or deleted, the panel asks you to pick it again. If a file was renamed, the next load rescans automatically.
- A legacy rubric placed directly in the root folder is still found when no week workbook exists.

## Per student
Open `https://moodle.cyber.org.il/mod/assign/view.php?id=…&action=grader&userid=…` and click
**שמירת ההגשה ויצירת סיכום**. The extension writes:

```
Solution\
└─ M_Week3\
   ├─ Solution\                    ← reference solution and rubric (read only)
   ├─ <שם הסטודנט>.zip              ← student's submission, renamed
   ├─ <שם הסטודנט> - סיכום.txt      ← answers (docx / online text) + all code files
   └─ _reference_for_AI.txt         ← official answers + rubric + solution code
```

It also writes `<שם הסטודנט> - חבילת AI.txt` in the same folder. **העתקת חבילה מלאה ל-AI** copies that same package, which contains:
the grading instructions, the rubric for this lesson, the official solution, the student's submission, and the JSON answer format.

## Master rubric (Excel)
The workbook for the selected week is found automatically (see above). To force a specific file name inside `M_WeekN\Solution`, set it in the settings.
- Each lesson is a **sheet** named `שיעור N`. The sheet is picked from the assignment number, and you can change it in the side panel.
- Columns are identified by their header text (`שם החניכה`, category headers, `ניקוד`/`ציון`, `לשימור`, `לשיפור`, `פתיחת מדריכ.ה`, `משוב`), so lessons with different layouts all work.
- The AI receives the weights (from `weights`), the 4-level criteria table, and the dropdown sentence lists for each category.
- The AI is told to return **exactly one sentence** in each retention/improvement field (E, F, H, I, K, L, N, O). If it sends more than one anyway, only the first is kept and a warning is shown.
- Paste the AI's answer into **תשובת ה-AI** and click **חישוב ושמירה בקובץ המחוון**. The extension:
  1. Re-reads the Excel file from disk.
  2. Finds the student's row by name: an exact match first, then an unambiguous first-name match, otherwise the first empty row.
  3. Writes columns D–P into that row.
  4. Saves the result back into **the same file** it read, through its own file handle. You're never asked to choose a file.
  - Grade and feedback come from the sheet's **own formulas**. The formulas stay in the cells, and their saved results are updated.
  - Before the first write each day, an untouched copy is saved to `Solution\_גיבוי מחוון\`.
  - **The Excel file must be closed** while saving. If Excel's lock file (`~$…`) is next to the workbook, or the write fails, the panel shows "יש לסגור את הקובץ ב-Excel" and nothing is changed.
  - Saving also fixes a problem from the Google Sheets export: `TEXTJOIN` is stored as `_xlfn.TEXTJOIN`, which Excel requires. Before that fix, the "משוב לחניכה" column showed `#NAME?` whenever Excel recalculated.
- To check the formula engine, I ran it on all 71 filled rows in the workbook. It reproduced Excel's saved grade and feedback for every one.

## Notes
- The student name, assignment number and target folder are filled in automatically and can be edited before saving.
- If the student uploaded a single ZIP, it is saved as is under the new name. Several files, or files that are not ZIPs, are bundled into a new ZIP.
- Nested ZIPs, `.docx`, `.ipynb` and common code/text files are extracted. `__pycache__`, `__MACOSX` and similar folders are skipped. Text in Windows-1255 (Hebrew) is decoded automatically.
- `.doc`, `.rar` and `.7z` are not extracted. PDF text extraction is best effort, and Hebrew PDFs usually need to be attached to the AI by hand.
- Without a chosen folder, files fall back to `Downloads\M_WeekN\` through `chrome.downloads`. Chrome cannot download to any other location, which is why the folder picker exists.
