const { Telegraf } = require("telegraf");
const User = require("./models/User");
const { createToken } = require("./tgTokens");

const MINI_APP_URL = () => process.env.MINI_APP_URL || "https://dadajon-tort.vercel.app/";
const OPERATOR_PHONES = ["331350206"];

let bot = null;

function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

    bot.command("start", async (ctx) => {
      const tgChatId = ctx.from.id;
      const firstName = ctx.from.first_name || "";

      try {
        const existingUser = await User.findByTgChatId(tgChatId);
        if (existingUser) {
          const token = await createToken(existingUser.id);
          const appUrl = `${MINI_APP_URL()}?tgToken=${token}`;
          return ctx.reply(
            `Salom, ${firstName}! ✅ Xush kelibsiz!\n\nQuyidagi tugmani bosib kiring:`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: "🍰 Dadajon Tort'ga kirish", web_app: { url: appUrl } },
                ]],
              },
            }
          );
        }
      } catch { /* silent */ }

      ctx.reply(
        `Salom! 👋 *Dadajon Tort*'ga xush kelibsiz!\n\nMazali tortlar va shirinliklar do'koni.\n\nKirish uchun telefon raqamingizni yuboring:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [[
              { text: "📱 Telefon yuborish", request_contact: true },
            ]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    });

    bot.on("contact", async (ctx) => {
      const firstName  = ctx.from.first_name || "Foydalanuvchi";
      const lastName   = ctx.from.last_name  || "";
      const fullName   = lastName ? `${firstName} ${lastName}` : firstName;
      const tgChatId   = ctx.from.id;
      const tgUsername = ctx.from.username ? `@${ctx.from.username}` : "";
      const rawPhone   = ctx.message.contact.phone_number.replace(/\D/g, "");
      const phone      = rawPhone.startsWith("998") ? rawPhone.slice(3) : rawPhone;

      try {
        // 1. Foydalanuvchini topish yoki AVTOMATIK yaratish
        let user = await User.findOne({ phone });
        let isNew = false;

        if (!user) {
          // Yangi user → DB ga avtomatik yozamiz
          isNew = true;
          user = await User.create({
            name:     fullName,
            phone,
            telegram: tgUsername,
          });
          console.log(`✅ Yangi user yaratildi: ${fullName} (${phone})`);
        }

        // 2. tg_chat_id ni bog'laymiz
        if (String(user.tg_chat_id) !== String(tgChatId)) {
          user = await User.findByIdAndUpdate(user.id, { tg_chat_id: tgChatId }) || user;
        }

        // 3. Bir martalik tgToken (to'g'ridan-to'g'ri kirish uchun)
        const tgToken = await createToken(user.id);
        const appUrl  = `${MINI_APP_URL()}?tgToken=${tgToken}`;

        // 4. Klaviaturani yashirish
        await ctx.reply("✅", { reply_markup: { remove_keyboard: true } });

        // 5. Mini App kirish xabari
        const welcomeText = isNew
          ? `🎉 *Xush kelibsiz, ${firstName}!*\n\nRo'yxatdan muvaffaqiyatli o'tdingiz.\n📱 Telefon: +998 ${phone}\n\nQuyidagi tugmani bosib kiring:`
          : `👋 *Salom, ${firstName}!*\n\nQuyidagi tugmani bosib kiring:`;

        await ctx.reply(welcomeText, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🍰 Dadajon Tort'ga kirish", web_app: { url: appUrl } }],
            ],
          },
        });

      } catch (e) {
        console.error("Bot contact handler xatosi:", e.message, e.stack);
        ctx.reply(
          `⚠️ Xato yuz berdi: ${e.message}\n\n/start bosib qayta urinib ko'ring.`
        ).catch(() => {});
      }
    });

    bot.command("id", (ctx) => {
      ctx.reply(`🆔 Sizning Telegram ID: \`${ctx.from.id}\``, { parse_mode: "Markdown" });
    });

    bot.command("help", (ctx) => {
      ctx.reply(
        `📖 *Dadajon Tort Bot yordam*\n\n` +
        `/start — Botni boshlash, kirish havolasi\n` +
        `/id — Telegram ID ni ko'rish\n\n` +
        `❓ Muammo bo'lsa: @Dadajon_admin ga murojaat qiling`,
        { parse_mode: "Markdown" }
      );
    });

    bot.launch()
      .then(() => console.log("🤖 Dadajon Tort bot ishga tushdi (polling rejim)"))
      .catch(err => {
        console.error("❌ Bot launch xatosi:", err.message);
        if (err.message.includes("401")) {
          console.error("⚠️  TELEGRAM_BOT_TOKEN noto'g'ri! @BotFather dan token oling.");
        }
      });

    process.once("SIGINT",  () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }
  return bot;
}

async function notifyUser(tgChatId, text, extra = {}) {
  if (!tgChatId) return;
  try {
    const { sendTg } = require('./utils/telegram');
    await sendTg(tgChatId, text, extra);
  } catch (e) {
    console.error("Bot xabar yuborishda xato:", e.message);
  }
}

// Barcha operatorlarga xabar yuborish
async function notifyOperator(text) {
  const b = getBot();
  if (!b) return;
  try {
    const { query } = require("./db");
    const { rows } = await query(
      "SELECT tg_chat_id FROM users WHERE phone = ANY($1) AND tg_chat_id IS NOT NULL",
      [OPERATOR_PHONES]
    );
    for (const row of rows) {
      await notifyUser(row.tg_chat_id, text).catch(() => {});
    }
  } catch (e) {
    console.error("notifyOperator xatosi:", e.message);
  }
}

module.exports = { getBot, notifyUser, notifyOperator };
