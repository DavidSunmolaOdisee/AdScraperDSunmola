import fs from "fs";
import path from "path";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const CREDENTIALS_PATH = path.resolve("client_secret.json");
const TOKEN_PATH = path.resolve("token.json");

export async function getSheetsClient() {
  const content = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  const { installed } = JSON.parse(content);
// src/sheetsAuth.js (vervang de oAuth2Client-regel)
const oAuth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
  "http://localhost" // forceer juiste redirect voor Desktop
);


  // token ophalen of genereren
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  } else {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    console.log("\nOpen deze URL en geef de code hierna in:\n", authUrl, "\n");
    const code = await promptStdin("Auth code: ");
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    oAuth2Client.setCredentials(tokens);
    console.log("OAuth token opgeslagen -> token.json\n");
  }

  const sheets = google.sheets({ version: "v4", auth: oAuth2Client });
  return sheets;
}

function promptStdin(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(d.toString().trim());
    });
  });
}
