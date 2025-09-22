// src/sheetsUtil.js (alleen de headers aanpassen; rest kan blijven)
import { getSheetsClient } from "./sheetsAuth.js";
import dotenv from "dotenv";
dotenv.config();

const DOC_ID = process.env.SHEETS_DOC_ID;
const TAB_UNI = process.env.UNIVERSAL_TAB || "UniversalDB";
const TAB_HIS = process.env.HISTORY_TAB || "History";

export async function appendUniversalRows(rows) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: DOC_ID,
    range: `${TAB_UNI}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

export async function appendHistoryRow(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: DOC_ID,
    range: `${TAB_HIS}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

// src/sheetsUtil.js  (alleen ensureHeaders aanpassen)
export async function ensureHeaders() {
  const sheets = await getSheetsClient();

  const uniHeaders = [
  "Ad Library URL","Store Name","Country","Reach","Product Link","Start Date",
  "Media Type","Platforms","Keyword","Ad ID","CTA",
  "Page Likes","Followers","Pagina" // ← nieuw
];

  await sheets.spreadsheets.values.update({
    spreadsheetId: DOC_ID,
    range: `${TAB_UNI}!A1:${colLetter(uniHeaders.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [uniHeaders] },
  });

  const histHeaders = [
    "Batch ID","Started At","Finished At","Keyword","Country",
    "Requested","Returned","Skipped","Notes"
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: DOC_ID,
    range: `${TAB_HIS}!A1:${colLetter(histHeaders.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [histHeaders] },
  });
}


function colLetter(n){
  let s=""; while(n){ let m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-1)/26|0; } return s;
}
