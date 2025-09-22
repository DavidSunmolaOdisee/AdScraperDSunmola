export const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","UK"
]);

export const isEUorUK = (code) => EU_UK.has(String(code || "").toUpperCase());
