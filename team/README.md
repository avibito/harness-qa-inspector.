# Harness QA — team app

Two ways to run the same code:

| | Shared folder (no Claude, no install) | Inside Claude |
|---|---|---|
| File | `dist/harness-qa-team.html` | published artifact |
| Data | `data/` inside a shared network folder, one JSON file per record | Claude artifact database |
| Users | picked by name from `data/team.json` (no password) | Claude accounts |
| Netlist from drawing | manual editor beside the drawing | manual editor + Claude extraction |
| Browser | Chrome or Edge on a computer | any |

## Shared-folder setup
1. Copy `dist/harness-qa-team.html` into a shared folder (e.g. `\\server\QA\HarnessQA`).
2. Open it in Chrome/Edge, click **בחר תיקייה** and choose that same folder; allow read/write.
3. The first person becomes admin and assigns roles (בודק / מאשר / מנהל) under **צוות**.

Identity is by name only: it records who did what but is not access control. Folder permissions on the network share are the real access control.

Build: `node build-single.mjs` (needs `lib/pdf.min.js` and `lib/pdf.worker.min.js` from pdfjs-dist 3.11.174).
