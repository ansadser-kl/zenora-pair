'use strict';
/*
 * ZENORA session site (no dependencies except baileys + pg).
 *
 *   /                       the page: enter number -> pairing code -> SESSION_ID
 *   POST /api/pair          { number, key? }  -> { token, code }
 *   GET  /api/status?token  -> { state: starting | code | linked | failed, code?, sessionId?, error? }
 *   GET  /session?id=...    -> { status: true, data: { creds: {...}, "pre-key-1": {...} } }   (what the bot downloads)
 *   GET  /health
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./lib/store');
const { startPairing } = require('./lib/pairing');

const PORT = Number(process.env.PORT) || 3000;
const ID_PREFIX = process.env.ID_PREFIX !== undefined ? process.env.ID_PREFIX : 'ZENORA~';
const ACCESS_KEY = process.env.ACCESS_KEY || '';                       // optional: only people with the key can link a number
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE) || 5;                // logins running at the same time
const PAIR_PER_HOUR = Number(process.env.PAIR_PER_HOUR) || 5;          // pairing requests per IP per hour
const SESSION_PER_MIN = Number(process.env.SESSION_PER_MIN) || 60;     // /session requests per IP per minute
const CODE_WAIT_MS = Number(process.env.CODE_WAIT_MS) || 25000;
const OPEN_JOB_TTL = 4 * 60 * 1000;                                    // a login nobody finishes is dropped after 4 minutes
const DONE_JOB_TTL = 15 * 60 * 1000;                                   // a finished login can be re-read on the page for 15 minutes

const store = createStore();
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const jobs = new Map();       // token -> job
const pairHits = new Map();   // ip -> [timestamps]
const sessionHits = new Map();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function siteBaseUrl(req) {
	const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	return proto + '://' + host;
}

function buildSessionMessage(id, base) {
	return [
		'✅ *WhatsApp linked*',
		'',
		'SESSION_ID:',
		id,
		'',
		"Put these in your bot's environment:",
		'SESSION_ID=' + id,
		'SESSION_API=' + base + '/session',
		'',
		'Keep this secret — anyone who has it can use this WhatsApp login.',
	].join('\n');
}

function allow(map, ip, limit, windowMs) {
	const now = Date.now();
	const list = (map.get(ip) || []).filter((t) => now - t < windowMs);
	if (list.length >= limit) { map.set(ip, list); return false; }
	list.push(now);
	map.set(ip, list);
	return true;
}

function send(res, code, body, headers = {}) {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	res.writeHead(code, Object.assign({
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	}, headers));
	res.end(text);
}

function readJson(req, limit = 4096) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) { if (size - c.length <= limit) reject(new Error('too large')); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad json')); }
		});
		req.on('error', reject);
	});
}

const activeJobs = () => [...jobs.values()].filter((j) => j.state === 'starting' || j.state === 'code').length;

function dropJob(token) {
	const job = jobs.get(token);
	if (!job) return;
	try { job.pairing && job.pairing.stop(); } catch (e) { /* ignore */ }
	jobs.delete(token);
}

setInterval(() => {
	const now = Date.now();
	for (const [token, job] of jobs) {
		const ttl = job.state === 'linked' ? DONE_JOB_TTL : OPEN_JOB_TTL;
		if (now - job.created > ttl) dropJob(token);
	}
	for (const map of [pairHits, sessionHits]) {
		for (const [ip, list] of map) if (!list.some((t) => now - t < 3600 * 1000)) map.delete(ip);
	}
}, 30000).unref();

async function handlePair(req, res) {
	let body;
	try { body = await readJson(req); } catch (e) { return send(res, 400, { status: false, message: 'Bad request' }); }

	if (ACCESS_KEY && !safeEqual(body.key || '', ACCESS_KEY)) return send(res, 401, { status: false, message: 'Wrong access key' });

	const number = String(body.number || '').replace(/\D/g, '');
	if (number.length < 7 || number.length > 15) {
		return send(res, 400, { status: false, message: 'Enter your WhatsApp number with country code (digits only, no +).' });
	}
	if (!allow(pairHits, clientIp(req), PAIR_PER_HOUR, 3600 * 1000)) {
		return send(res, 429, { status: false, message: 'Too many tries. Please wait a while and try again.' });
	}
	if (activeJobs() >= MAX_ACTIVE) return send(res, 503, { status: false, message: 'Server is busy, please try again in a minute.' });

	const token = crypto.randomBytes(16).toString('hex');
	const job = { state: 'starting', code: null, sessionId: null, error: null, created: Date.now(), pairing: null };
	jobs.set(token, job);

	job.pairing = startPairing(number, {
		onCode(code) { if (job.state === 'starting' || job.state === 'code') { job.state = 'code'; job.code = code; } },
		async onLinked(sessionJson) {
			// errors here are caught by pairing.js, which then calls onFail below with a message for the page
			const id = ID_PREFIX + crypto.randomBytes(24).toString('base64url');
			await store.save(id, sessionJson);
			job.sessionId = id;
			job.state = 'linked';
			job.created = Date.now();
			return { message: buildSessionMessage(id, siteBaseUrl(req)) };
		},
		onFail(message) { if (job.state !== 'linked') { job.state = 'failed'; job.error = message; } },
	});

	// wait until the code is ready (or it failed)
	const started = Date.now();
	while (job.state === 'starting' && Date.now() - started < CODE_WAIT_MS) await new Promise((r) => setTimeout(r, 100));

	if (job.state === 'code' || job.state === 'linked') return send(res, 200, { status: true, token, code: job.code });
	const message = job.error || 'Could not get a pairing code. Please try again.';
	dropJob(token);
	return send(res, job.error ? 400 : 504, { status: false, message });
}

function handleStatus(url, res) {
	const job = jobs.get(url.searchParams.get('token') || '');
	if (!job) return send(res, 404, { status: false, state: 'unknown', message: 'Not found or expired. Start again.' });
	return send(res, 200, { status: true, state: job.state, code: job.code, sessionId: job.sessionId, error: job.error });
}

async function handleSession(req, url, res) {
	if (!allow(sessionHits, clientIp(req), SESSION_PER_MIN, 60 * 1000)) return send(res, 429, { status: false, message: 'Too many requests' });
	const id = url.searchParams.get('id') || '';
	if (!id || id.length > 200) return send(res, 400, { status: false, message: 'Missing id' });
	let creds;
	try { creds = await store.get(id); } catch (e) {
		console.error('[site] store error:', e.message);
		return send(res, 500, { status: false, message: 'Storage error' });
	}
	if (!creds) return send(res, 404, { status: false, message: 'Session not found' });
	return send(res, 200, '{"status":true,"data":' + creds + '}');
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost');
		const route = req.method + ' ' + url.pathname;

		if (route === 'GET /' || route === 'GET /index.html') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
			});
			return res.end(indexHtml);
		}
		if (route === 'GET /api/config') return send(res, 200, { needKey: !!ACCESS_KEY });
		if (route === 'POST /api/pair') return await handlePair(req, res);
		if (route === 'GET /api/status') return handleStatus(url, res);
		if (route === 'GET /session') return await handleSession(req, url, res);
		if (route === 'GET /health') return send(res, 200, { ok: true, storage: store.kind, sessions: await store.count() });
		return send(res, 404, { status: false, message: 'Not found' });
	} catch (e) {
		console.error('[site] error:', e.message);
		if (!res.headersSent) send(res, 500, { status: false, message: 'Server error' });
	}
});

function shutdown() {
	for (const token of [...jobs.keys()]) dropJob(token);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[site] unhandled:', e && e.message));

store.init().then(() => {
	server.listen(PORT, () => {
		console.log('[site] listening on port ' + PORT + ' | storage: ' + store.kind + (ACCESS_KEY ? ' | access key required' : ''));
	});
}).catch((e) => {
	console.error('[site] could not start the storage:', e.message);
	process.exit(1);
});

module.exports = { server };
