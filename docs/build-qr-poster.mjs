// Genera un cartel PDF con los 2 QR rotulados (Chrome headless).
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const b64 = (p) => readFileSync(p).toString("base64");
const logo = b64(join(root, "src/assets/logo-ampm.png"));
const qrSup = b64(join(__dirname, "qr/QR-Supervisor.png"));
const qrTerm = b64(join(__dirname, "qr/QR-Terminal-Tienda.png"));

const card = (qr, titulo, url, desc, color) => `
  <div class="card">
    <div class="cap" style="background:${color}">${titulo}</div>
    <img class="qr" src="data:image/png;base64,${qr}" alt="${titulo}"/>
    <div class="url">${url}</div>
    <div class="desc">${desc}</div>
  </div>`;

const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm; }
  body { font-family:"Segoe UI",Arial,sans-serif; color:#1f2933; margin:0; }
  .brand { display:flex; align-items:center; gap:14px; border-bottom:3px solid #c8102e; padding-bottom:12px; margin-bottom:24px; }
  .brand img { height:46px; }
  .brand .t { font-size:18pt; font-weight:bold; }
  .brand .s { font-size:9pt; color:#7b8794; }
  .grid { display:flex; gap:24px; justify-content:center; }
  .card { width:46%; border:1px solid #cbd2d9; border-radius:16px; overflow:hidden; text-align:center; }
  .cap { color:#fff; font-weight:700; font-size:14pt; padding:12px; }
  .qr { width:78%; height:auto; margin:18px auto 6px; display:block; }
  .url { font-family:Consolas,monospace; font-size:9.5pt; color:#9b1b2e; word-break:break-all; padding:0 14px; }
  .desc { font-size:10pt; color:#52606d; padding:10px 16px 20px; }
  .foot { margin-top:26px; font-size:9pt; color:#7b8794; text-align:center; }
</style></head><body>
  <div class="brand">
    <img src="data:image/png;base64,${logo}"/>
    <div><div class="t">Accesos del Sistema de Marcaje</div><div class="s">AM/PM Centroamérica</div></div>
  </div>
  <div class="grid">
    ${card(qrSup, "Acceso Supervisor", "marcajeampm.vercel.app/admin", "Para Gerentes de Tienda, de Zona y Administradores. Escanea para entrar al panel e iniciar sesión con tu correo y contraseña.", "#1f2933")}
    ${card(qrTerm, "Terminal de Tienda", "marcajeampm.vercel.app", "Para marcar entrada/salida. Escanea en la tablet de la tienda; la primera vez se configura con el código de tienda y el PIN de terminal.", "#c8102e")}
  </div>
  <div class="foot">Escanea con la cámara del teléfono o tablet. Imprime y coloca cada QR donde corresponda.</div>
</body></html>`;

const htmlPath = join(__dirname, "qr/_poster.html");
const pdfPath = join(__dirname, "qr/Carteles-QR.pdf");
writeFileSync(htmlPath, html, "utf8");
execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, htmlPath], { stdio: "ignore" });
rmSync(htmlPath, { force: true });
console.log("OK:", pdfPath);
