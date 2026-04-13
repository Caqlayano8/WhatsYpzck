const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

function resolveOutputPath() {
  const desktop = path.join(os.homedir(), 'Desktop');
  return path.join(desktop, 'WhatsYpzck-Erisim-Ozeti.pdf');
}

function buildAccounts() {
  return [
    {
      title: 'Admin / Yonetici',
      username: process.env.DEFAULT_ADMIN_USER || 'admin',
      password: process.env.DEFAULT_ADMIN_PASS || '-',
      role: 'admin',
      notes: 'Tum admin paneli ve mobil yonetim ekranlari',
    },
    {
      title: 'Teknisyen',
      username: process.env.DEFAULT_TECH_USER || 'teknisyen',
      password: process.env.DEFAULT_TECH_PASS || '-',
      role: 'field_tech',
      notes: 'Ariza guncelleme ve saha operasyonlari',
    },
    {
      title: 'Kullanici',
      username: process.env.DEFAULT_VIEWER_USER || 'kullanici',
      password: process.env.DEFAULT_VIEWER_PASS || '-',
      role: 'viewer',
      notes: 'Mobil ariza listesi ve profil erisimi',
    },
  ];
}

function buildHtml(accounts) {
  const generatedAt = new Date().toLocaleString('tr-TR');
  const accountCards = accounts.map((account) => `
    <div class="card">
      <div class="card-title">${account.title}</div>
      <div class="row"><span>Kullanici Adi</span><strong>${account.username}</strong></div>
      <div class="row"><span>Sifre</span><strong>${account.password}</strong></div>
      <div class="row"><span>Rol Kodu</span><strong>${account.role}</strong></div>
      <div class="row"><span>Erisim</span><strong>${account.notes}</strong></div>
    </div>
  `).join('');

  const updates = [
    'Admin panelinden admin, kullanici ve teknisyen olusturma akisi birlestirildi.',
    'Mobil uygulama ile admin panel ayni rol kodlarini kullaniyor: admin, field_tech, viewer.',
    'Varsayilan hesaplar seed mekanizmasina eklendi; uygulama acilisinda hazir geliyor.',
    'Mobil API katmaninda web token saklama ve ariza notu gonderim hatasi duzeltildi.',
  ].map((item) => `<li>${item}</li>`).join('');

  return `
    <!doctype html>
    <html lang="tr">
      <head>
        <meta charset="utf-8" />
        <title>WhatsYpzck Erisim Ozeti</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 36px; color: #18212f; background: #f4f7fb; }
          .page { background: #ffffff; border-radius: 24px; padding: 32px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.12); }
          .eyebrow { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #56657f; margin-bottom: 10px; }
          h1 { margin: 0 0 6px; font-size: 28px; color: #10203a; }
          .sub { margin: 0 0 24px; color: #5d6b82; font-size: 14px; }
          .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 24px 0 28px; }
          .card { border: 1px solid #d9e2ef; border-radius: 18px; padding: 18px; background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%); }
          .card-title { font-size: 16px; font-weight: 700; margin-bottom: 14px; color: #16325d; }
          .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; padding: 7px 0; border-bottom: 1px solid #eef3f9; }
          .row:last-child { border-bottom: 0; }
          .row span { color: #6b7a92; }
          .section-title { margin: 26px 0 10px; font-size: 18px; color: #16325d; }
          ul { margin: 0; padding-left: 18px; color: #31425d; }
          li { margin-bottom: 8px; font-size: 14px; }
          .note { margin-top: 22px; padding: 14px 16px; background: #fff7e8; border: 1px solid #f0d69a; border-radius: 14px; font-size: 13px; color: #6d5314; }
          .footer { margin-top: 24px; font-size: 12px; color: #7a8799; }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="eyebrow">WhatsYpzck</div>
          <h1>Erisim ve Guncelleme Ozeti</h1>
          <p class="sub">Olusturma tarihi: ${generatedAt}</p>

          <div class="grid">${accountCards}</div>

          <div class="section-title">Son Guncellemeler</div>
          <ul>${updates}</ul>

          <div class="note">
            Bu PDF varsayilan seed hesaplarini icerir. Admin panelinden daha sonra yeni kullanici eklerseniz, sifreler veritabaninda sifreli tutulur ve geriye duz metin olarak okunamaz.
          </div>

          <div class="footer">Admin panel: http://localhost:${process.env.PORT || '54112'}/admin • Mobil web: http://localhost:19006</div>
        </div>
      </body>
    </html>
  `;
}

async function main() {
  const outputPath = resolveOutputPath();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(buildHtml(buildAccounts()), { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '12mm', bottom: '16mm', left: '12mm' },
    });
    process.stdout.write(outputPath);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});