const { query, withTransaction } = require("../db");

const OfflineSale = {
  async create({ productId, qty, operatorId, note }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE products SET qty = qty - $1, updated_at = NOW()
         WHERE id = $2 AND qty >= $1
         RETURNING name, price`,
        [qty, productId]
      );
      const product = rows[0];
      if (!product) throw new Error("Omborda yetarli mahsulot yo'q");

      const totalPrice = Number(product.price) * qty;
      const { rows: saleRows } = await client.query(
        `INSERT INTO offline_sales
           (product_id, product_name, unit_price, qty, total_price, operator_id, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [productId, product.name, product.price, qty, totalPrice, operatorId, note || ""]
      );
      return saleRows[0];
    });
  },

  async findByOperator(operatorId, { from, to } = {}) {
    const conditions = [`operator_id = $1`];
    const values = [operatorId];
    let i = 2;
    if (from) { conditions.push(`created_at >= $${i++}`); values.push(from); }
    if (to)   { conditions.push(`created_at <= $${i++}`); values.push(to); }
    const { rows } = await query(
      `SELECT * FROM offline_sales WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      values
    );
    return rows;
  },

  async findAll({ from, to } = {}) {
    const conditions = [];
    const values = [];
    let i = 1;
    if (from) { conditions.push(`created_at >= $${i++}`); values.push(from); }
    if (to)   { conditions.push(`created_at <= $${i++}`); values.push(to); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await query(
      `SELECT * FROM offline_sales ${where} ORDER BY created_at DESC`,
      values
    );
    return rows;
  },

  async statsByOperator(from, to) {
    const { rows } = await query(
      `SELECT operator_id, COUNT(*) AS sale_count,
              COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(total_price),0) AS revenue
       FROM offline_sales
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY operator_id`,
      [from, to]
    );
    return rows.map((r) => ({
      operatorId: r.operator_id,
      saleCount: Number(r.sale_count),
      qty: Number(r.qty),
      revenue: Number(r.revenue),
    }));
  },

  async statsByProduct(from, to) {
    const { rows } = await query(
      `SELECT product_id, product_name,
              COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(total_price),0) AS revenue
       FROM offline_sales
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY product_id, product_name
       ORDER BY revenue DESC`,
      [from, to]
    );
    return rows.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      qty: Number(r.qty),
      revenue: Number(r.revenue),
    }));
  },

  async statsDaily(date, operatorId) {
    const conditions = [`created_at::date = $1`];
    const values = [date];
    if (operatorId) {
      conditions.push(`operator_id = $2`);
      values.push(operatorId);
    }
    const { rows } = await query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_price),0) AS revenue
       FROM offline_sales WHERE ${conditions.join(" AND ")}`,
      values
    );
    return { count: Number(rows[0].count), revenue: Number(rows[0].revenue) };
  },
};

module.exports = OfflineSale;
