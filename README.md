# PSG Practical Examination Management System (PEMS)

Generates the official PSG Polytechnic College Semester Practical Examination documents and attendance sheets as Word and PDF files.

- **Examination document**: enter the details, upload the syllabus (PDF or Word), check the extracted List of Experiments, then generate one Word and one PDF file with the List of Experiments, Question Paper and Allocation of Marks.
- **Attendance Sheets**: add students by importing Excel, CSV or Word, or by generating roll numbers from a prefix (24DI, 25DI, 26DI, 24DX or any other), then generate an S.No. · Name · Roll No. · Signature sheet with the Internal and External Examiner signatures at the bottom of the last page. Every generation is kept as a new version.

## Run

Double-click `start.bat`, or:

```powershell
npm run dev
```

Open http://localhost:3000/. The server starts the private MariaDB instance (XAMPP `mysqld.exe`, data in `var/mysql`, loopback port 33317) when it is not already running. Sign-in details are in `var/credentials.txt` and `var/administrator.txt`; keep them private.

## Layout

- `server/index.js`: Express server, sessions, and the page template (`public/index.php` is served by Node, not PHP).
- `server/routes/api.js`: the JSON/file API at `/api.php?op=…` (CSRF protected).
- `server/services/`: document builder (`documentService.js`, uses `server/templates/official-reference.docx`), attendance sheets (`attendanceService.js`), syllabus reader, PDF conversion (Microsoft Word, LibreOffice as fallback), data access.
- `server/migrations.js`: additive schema changes applied at start-up. `server/schema.sql` is the original base schema.
- `public/`: plain JavaScript and CSS interface (`tracker.js` draws the cursor-following sign-in deck and dot fields).
- `var/`: database files, generated documents, uploads, backups, logs and credentials. Keep it out of source control and public hosting.

## Requirements

Node.js 20+, MariaDB (XAMPP) and Microsoft Word or LibreOffice for PDF conversion. Server packages are in `server/node_modules` (`npm install` inside `server/`).
