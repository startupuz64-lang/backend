require("dotenv").config();

const app = require("./app");
const { connect } = require("./db");

// Bitta so'rovdagi kutilmagan xato butun serverni qulatib qo'ymasin —
// faqat log qilib, jarayonni tirik saqlaymiz.
process.on("unhandledRejection", (err) => {
  console.error("⚠️  Unhandled rejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️  Uncaught exception:", err?.message || err);
});

async function start() {
  await connect();

  const { getBot } = require('./bot');
  if (process.env.TELEGRAM_BOT_TOKEN) {
    getBot();
  } else {
    console.log('⚠️  TELEGRAM_BOT_TOKEN topilmadi — bot ishga tushmadi');
  }

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server http://localhost:${PORT} da ishlamoqda`);
  });
}

start().catch((err) => {
  console.error("❌ Server start xatosi:", err.message);
  process.exit(1);
});

module.exports = app;
