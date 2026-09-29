import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

function postgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function createPostgresDatabase(pool, queryable = pool) {
  const query = (sql, params = []) => queryable.query(postgresPlaceholders(sql), params);
  return {
    dialect: 'postgres',
    async exec(sql) {
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await queryable.query(statement);
    },
    async all(sql, ...params) {
      return (await query(sql, params)).rows;
    },
    async get(sql, ...params) {
      return (await query(sql, params)).rows[0] || null;
    },
    async run(sql, ...params) {
      return query(sql, params);
    },
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(createPostgresDatabase(pool, client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function createSqliteDatabase(databasePath) {
  const sqlite = new DatabaseSync(databasePath);
  const transactionContext = new AsyncLocalStorage();
  let pending = Promise.resolve();
  let database;

  async function exclusive(operation) {
    if (transactionContext.getStore() === database) return operation();
    const previous = pending;
    let release;
    pending = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  database = {
    dialect: 'sqlite',
    exec: sql => exclusive(() => sqlite.exec(sql)),
    all: (sql, ...params) => exclusive(() => sqlite.prepare(sql).all(...params)),
    get: (sql, ...params) => exclusive(() => sqlite.prepare(sql).get(...params) || null),
    run: (sql, ...params) => exclusive(() => sqlite.prepare(sql).run(...params)),
    transaction: callback => exclusive(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await transactionContext.run(database, () => callback(database));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => sqlite.close(),
  };
  return database;
}

export function createDatabase({ databasePath, connectionString = process.env.DATABASE_URL } = {}) {
  if (connectionString) return createPostgresDatabase(new Pool({ connectionString }));
  return createSqliteDatabase(databasePath);
}