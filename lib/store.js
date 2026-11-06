'use strict';
/*
 * Where the sessions are kept.
 *   DATABASE_URL set  -> PostgreSQL (use this on Render: the free web service disk is wiped on every restart)
 *   otherwise         -> a JSON file (data/sessions.json), fine for a VPS / local testing
 * Each session is stored as one JSON text: { "creds": {...}, "pre-key-1": {...}, ... }
 */
const fs = require('fs');
const path = require('path');

function fileStore(file) {
	const data = new Map();
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		for (const [id, row] of Object.entries(parsed)) data.set(id, row);
	} catch (e) { /* first start */ }

	const flush = () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(data)));
		fs.renameSync(tmp, file);
	};

	return {
		kind: 'file',
		async init() {},
		async save(id, creds) { data.set(id, { creds, created: new Date().toISOString() }); flush(); },
		async get(id) { const row = data.get(id); return row ? row.creds : null; },
		async count() { return data.size; },
	};
}

function pgStore(url) {
	const { Pool } = require('pg');
	const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
	const pool = new Pool({
		connectionString: url,
		ssl: local || process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
	});
	return {
		kind: 'postgres',
		async init() {
			await pool.query('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, creds TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
		},
		async save(id, creds) {
			await pool.query('INSERT INTO sessions (id, creds) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET creds = EXCLUDED.creds', [id, creds]);
		},
		async get(id) {
			const r = await pool.query('SELECT creds FROM sessions WHERE id = $1', [id]);
			return r.rows[0] ? r.rows[0].creds : null;
		},
		async count() {
			const r = await pool.query('SELECT count(*)::int AS n FROM sessions');
			return r.rows[0].n;
		},
	};
}

function createStore() {
	const url = (process.env.DATABASE_URL || '').trim();
	if (url) return pgStore(url);
	return fileStore(path.resolve(process.env.DATA_FILE || 'data/sessions.json'));
}

module.exports = { createStore };
