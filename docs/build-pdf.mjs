// Genera PDF con logo a partir de los manuales .md usando Chrome headless.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(__dirname, "pdf");
mkdirSync(outDir, { recursive: true });

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const logoB64 = readFileSync(join(root, "src/assets/logo-ampm.png")).toString("base64");

const files = [
  "Manual-Gerente-de-Tienda",
  "Manual-Gerente-de-Zona",
  "Manual-Super-Administrador",
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^---+\s*$/.test(line)) { out.push("<hr/>"); i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++; continue;
    }
    // Tabla
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i]); i++;
      }
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(rows[0]);
      const body = rows.slice(2); // rows[1] es el separador |---|
      let t = '<table><thead><tr>' + header.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of body) t += "<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      t += "</tbody></table>";
      out.push(t); continue;
    }
    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    // Lista ordenada
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push("<ol>" + buf.map((b) => `<li>${inline(b)}</li>`).join("") + "</ol>"); continue;
    }
    // Lista no ordenada
    if (/^\s*[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      out.push("<ul>" + buf.map((b) => `<li>${inline(b)}</li>`).join("") + "</ul>"); continue;
    }
    // Párrafo
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4})\s|^>\s?|^\s*[-*]\s|^\s*\d+\.\s|^\s*\|/.test(lines[i]) && !/^---+\s*$/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

const css = `
  @page { size: A4; margin: 16mm 15mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1f2933; font-size: 11pt; line-height: 1.5; margin: 0; }
  .brand { display:flex; align-items:center; gap:14px; border-bottom:3px solid #c8102e; padding-bottom:12px; margin-bottom:18px; }
  .brand img { height:46px; width:auto; }
  .brand .sys { margin-left:auto; font-size:9pt; color:#7b8794; text-align:right; }
  h1 { font-size:19pt; color:#1f2933; margin:6px 0 4px; }
  h2 { font-size:13.5pt; color:#c8102e; margin:18px 0 6px; padding-bottom:3px; border-bottom:1px solid #e4e7eb; page-break-after:avoid; }
  h3 { font-size:11.5pt; color:#1f2933; margin:12px 0 4px; page-break-after:avoid; }
  p { margin:6px 0; }
  ul, ol { margin:6px 0 6px 4px; padding-left:20px; }
  li { margin:3px 0; }
  hr { border:0; border-top:1px solid #e4e7eb; margin:14px 0; }
  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:10pt; page-break-inside:auto; }
  th, td { border:1px solid #cbd2d9; padding:6px 9px; text-align:left; vertical-align:top; }
  th { background:#f5f0ec; color:#9b1b2e; font-weight:600; }
  tr { page-break-inside:avoid; }
  blockquote { margin:10px 0; padding:8px 12px; background:#fbf6f1; border-left:4px solid #c8102e; color:#52606d; border-radius:0 6px 6px 0; }
  code { background:#f0f2f4; padding:1px 5px; border-radius:4px; font-family:Consolas,monospace; font-size:9.5pt; color:#b91c1c; }
  strong { color:#1f2933; }
  a { color:#9b1b2e; text-decoration:none; }
  h2, h3, table, blockquote { break-inside: avoid; }
`;

const built = [];
for (const f of files) {
  const md = readFileSync(join(__dirname, f + ".md"), "utf8");
  // Quitamos el primer h1 del cuerpo (lo ponemos en el encabezado de marca)
  const html = mdToHtml(md);
  const doc = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><style>${css}</style></head>
<body>
  <div class="brand">
    <img src="data:image/png;base64,${logoB64}" alt="AM/PM"/>
    <div class="sys">Sistema de Marcaje<br/>AM/PM Centroamérica</div>
  </div>
  ${html}
</body></html>`;
  const htmlPath = join(outDir, f + ".html");
  const pdfPath = join(outDir, f + ".pdf");
  writeFileSync(htmlPath, doc, "utf8");
  execFileSync(CHROME, [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    htmlPath,
  ], { stdio: "ignore" });
  rmSync(htmlPath, { force: true });
  built.push(pdfPath);
  console.log("OK:", pdfPath);
}
console.log("TOTAL:", built.length);
