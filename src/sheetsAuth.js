// src/sheetsAuth.js
import fs from "fs";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const TOKEN_PATH = "token.json";

export async function getSheetsClient() {
  // Credentials uit environment (Render → Environment tab)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID of GOOGLE_CLIENT_SECRET ontbreekt in env");
  }

  const oAuth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "http://localhost" // redirect voor lokale auth
  );

  // token ophalen of genereren
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  } else {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    console.log("\nOpen deze URL en plak de code:\n", authUrl, "\n");
    const code = await promptStdin("Auth code: ");
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    oAuth2Client.setCredentials(tokens);
    console.log("OAuth token opgeslagen -> token.json\n");
  }

  return google.sheets({ version: "v4", auth: oAuth2Client });
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
