// authDB.js
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const db = require('./db');

/**
 * Custom authentication state for PostgreSQL.
 * @param {string} sessionName - A unique identifier for the session.
 * @returns {Promise<{state: {creds: any, keys: {get: function, set: function}}, saveCreds: function}>}
 */
async function usePostgresAuthState(sessionName) {
    const credsTableName = 'auth_creds';
    const keysTableName = 'auth_keys';

    // 1. Ensure the tables exist
    await db.query(`
        CREATE TABLE IF NOT EXISTS ${credsTableName} (
            id serial PRIMARY KEY,
            creds_data JSONB NOT NULL
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS ${keysTableName} (
            id TEXT PRIMARY KEY,
            key_data BYTEA NOT NULL
        )
    `);

    // 2. Load credentials
    let creds = (await db.query(`SELECT creds_data FROM ${credsTableName} LIMIT 1`)).rows[0];

    if (!creds) {
        // If no credentials found, initialize new ones
        creds = initAuthCreds();
    } else {
        // Otherwise, parse existing credentials
        try {
            creds = JSON.parse(creds.creds_data, BufferJSON.reviver);
        } catch (error) {
            console.error('Error parsing creds from DB:', error);
            creds = initAuthCreds(); // Fallback to new creds
        }
    }

    // 3. Define the functions to get and set key data
    const keyStore = {
        get: async (key, type) => {
            const id = `${key}-${type}`;
            const result = await db.query(`SELECT key_data FROM ${keysTableName} WHERE id = $1`, [id]);
            if (result.rows.length > 0) {
                return proto.Message.decode(result.rows[0].key_data);
            }
            return null;
        },
        set: async (key, type, data) => {
            const id = `${key}-${type}`;
            const buffer = proto.Message.encode(data).finish();
            await db.query(
                `INSERT INTO ${keysTableName} (id, key_data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET key_data = $2`,
                [id, buffer]
            );
        },
        delete: async (key, type) => {
             const id = `${key}-${type}`;
             await db.query(`DELETE FROM ${keysTableName} WHERE id = $1`, [id]);
        }
    };
    

    // 4. Define the function to save credentials
    const saveCreds = async () => {
        const credsJSON = JSON.stringify(creds, BufferJSON.replacer);
        await db.query(`
            INSERT INTO ${credsTableName} (id, creds_data) VALUES (1, $1) 
            ON CONFLICT (id) DO UPDATE SET creds_data = EXCLUDED.creds_data
        `, [credsJSON]);
    };

    return {
        state: {
            creds,
            keys: {
                get: (type, key) => keyStore.get(key, type),
                set: (type, key, data) => keyStore.set(key, type, data),
            }
        },
        saveCreds,
    };
}

module.exports = { usePostgresAuthState };
