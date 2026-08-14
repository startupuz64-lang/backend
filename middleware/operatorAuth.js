const jwt = require("jsonwebtoken");
const { query } = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "remarket_secret_key_2024";

// Operator telefon va telegram ro'yxati
const OPERATOR_PHONES    = ["331350206"];
const OPERATOR_TELEGRAMS = ["@Dadajon_admin", "@dadajon_admin"];

module.exports = async function operatorAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token talab etiladi" });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const { rows } = await query("SELECT * FROM users WHERE id = $1 LIMIT 1", [decoded.id]);
    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Foydalanuvchi topilmadi" });
    if (user.is_blocked) return res.status(403).json({ message: "Hisobingiz bloklangan" });

    const isOperator =
      OPERATOR_PHONES.includes(user.phone) ||
      OPERATOR_TELEGRAMS.map(t => t.toLowerCase()).includes((user.telegram || "").toLowerCase()) ||
      user.role === "operator";

    if (!isOperator) {
      return res.status(403).json({ message: "Ruxsat yo'q" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Token yaroqsiz" });
  }
};
