'use strict';

function buildInsertSql(table, columns, rowCount) {
  const placeholders = [];
  let paramIndex = 1;
  for (let i = 0; i < rowCount; i += 1) {
    const rowPlaceholders = [];
    for (let j = 0; j < columns.length; j += 1) {
      rowPlaceholders.push(`$${paramIndex}`);
      paramIndex += 1;
    }
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
  }
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`;
}

async function insertRows(client, table, columns, rows) {
  if (!rows || rows.length === 0) return 0;
  const values = [];
  for (const row of rows) {
    for (const column of columns) {
      values.push(row[column]);
    }
  }
  const sql = buildInsertSql(table, columns, rows.length);
  await client.query(sql, values);
  return rows.length;
}

module.exports = {
  insertRows,
};
