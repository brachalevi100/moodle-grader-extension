# Moodle Grader Assistant (Chrome, Manifest V3)

## Install
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder (`moodle-grader-extension`).
3. Pin the extension. Clicking the icon opens the side panel.

## First run
In the side panel, click **בחירת תיקייה** and select `C:\Users\ברכה\Desktop\Projects\Solution`
(the folder that contains `M_Week3`, `M_Week4`, …). Chrome remembers it. After a browser restart it may ask
once more for permission; choose "Allow on every visit".

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
`Solution\מערכות הפעלה - מחוון בדיקת תרגילי בית.xlsx` is detected automatically. Any `*מחוון*.xlsx` file in the base folder works, or you can set the file name in the settings.
- Each lesson is a **sheet** named `שיעור N`. The sheet is picked from the assignment number, and you can change it in the side panel.
- Columns are identified by their header text (`שם החניכה`, category headers, `ניקוד`/`ציון`, `לשימור`, `לשיפור`, `פתיחת מדריכ.ה`, `משוב`), so lessons with different layouts all work.
- The AI receives the weights (from `weights`), the 4-level criteria table, and the dropdown sentence lists for each category.
- Paste the AI's answer into **תשובת ה-AI** and click **חישוב ציון ומשוב**. The grade and feedback are calculated by running the sheet's **own formulas**, the same ones in the grade and "משוב לחניכה (נגזר אוטומטית)" columns.
  - Use **העתקת המשוב** to copy the feedback for Moodle.
  - Use **העתקת שורה לגיליון** to copy the row, then paste it into the student's row in the sheet.
- To check the formula engine, I ran it on all 71 filled rows in the workbook. It reproduced Excel's saved grade and feedback for every one.

## Notes
- The student name, assignment number and target folder are filled in automatically and can be edited before saving.
- If the student uploaded a single ZIP, it is saved as is under the new name. Several files, or files that are not ZIPs, are bundled into a new ZIP.
- Nested ZIPs, `.docx`, `.ipynb` and common code/text files are extracted. `__pycache__`, `__MACOSX` and similar folders are skipped. Text in Windows-1255 (Hebrew) is decoded automatically.
- `.doc`, `.rar` and `.7z` are not extracted. PDF text extraction is best effort, and Hebrew PDFs usually need to be attached to the AI by hand.
- Without a chosen folder, files fall back to `Downloads\M_WeekN\` through `chrome.downloads`. Chrome cannot download to any other location, which is why the folder picker exists.
