const QRCode = require("qrcode");

async function generateQrDataUrl(text) {
  return QRCode.toDataURL(String(text), { width: 300, margin: 1 });
}

module.exports = { generateQrDataUrl };
