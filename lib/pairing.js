'use strict';
/*
 * Links one WhatsApp number with Baileys, either with a pairing code or a QR code.
 *
 *   startPairing(phone, { onCode, onLinked, onFail })   pairing-code flow
 *   startQrLogin({ onQR, onLinked, onFail })             QR-code flow
 *
 *   onCode(code)          the 8 letter code to type in WhatsApp > Linked devices
 *   onQR(qrText)          raw QR payload (render it as a QR image); fires again every time it refreshes
 *   onLinked(sessionJson) login finished; sessionJson = '{"creds":{...},"pre-key-1":{...},...}'
 *   onFail(message)       code/QR expired, refused, or an error happened
 *   job.stop()            cancel
 *
 * The login lives only in memory while linking. When it is finished the socket is CLOSED (not logged out),
 * so the bot that later uses the session is the only device connection (two connections = 440 conflict).
 */
const log = (...a) => console.log('[link]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETTLE_MS = Number(process.env.SETTLE_MS) || 8000; // time to let WhatsApp send the first keys after linking
const MAX_SOCKETS = 8;                                    // socket attempts per login
const SOCKET_TIMEOUT_MS = 150000;                         // a socket that never finishes must not live forever

const silentLogger = {
	level: 'silent',
	trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
	child() { return silentLogger; },
};

let apiPromise = null;
function getApi() {
	if (!apiPromise) {
		apiPromise = import('baileys').then((b) => {
			const pick = (name) => (b[name] !== undefined ? b[name] : b.default && b.default[name]);
			return {
				makeWASocket: typeof b.default === 'function' ? b.default : (b.default && b.default.default) || b.makeWASocket,
				BufferJSON: pick('BufferJSON'),
				initAuthCreds: pick('initAuthCreds'),
				proto: pick('proto'),
				DisconnectReason: pick('DisconnectReason') || {},
				makeCacheableSignalKeyStore: pick('makeCacheableSignalKeyStore'),
				Browsers: pick('Browsers'),
				fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion'),
			};
		});
	}
	return apiPromise;
}

// Auth state that lives in memory (same behaviour as Baileys' useMultiFileAuthState, without files)
function memoryAuthState(api) {
	const creds = api.initAuthCreds();
	const store = new Map(); // "pre-key:1" -> value
	const keys = {
		get: async (type, ids) => {
			const out = {};
			for (const id of ids) {
				let value = store.get(type + ':' + id);
				if (type === 'app-state-sync-key' && value && api.proto) {
					value = api.proto.Message.AppStateSyncKeyData.fromObject(value);
				}
				out[id] = value;
			}
			return out;
		},
		set: async (data) => {
			for (const type of Object.keys(data)) {
				for (const id of Object.keys(data[type])) {
					const value = data[type][id];
					if (value) store.set(type + ':' + id, value);
					else store.delete(type + ':' + id);
				}
			}
		},
	};
	// everything the bot needs, with the same key names the bot stores:  creds, pre-key-1, session-xxx ...
	const exportAll = () => {
		const map = { creds };
		for (const [k, value] of store) {
			const i = k.indexOf(':');
			map[k.slice(0, i) + '-' + k.slice(i + 1)] = value;
		}
		return JSON.stringify(map, api.BufferJSON.replacer);
	};
	return { creds, keys, exportAll };
}

// a real linked login has a device number in the id ("9198...:12@s.whatsapp.net"); the placeholder
// Baileys writes when a pairing code is requested has none
const isLinked = (creds) => !!(creds && creds.me && String(creds.me.id).includes(':'));

// mode: 'pair' (needs phone) or 'qr' (phone is null)
function runSocket(api, state, mode, phone, hooks) {
	return new Promise((resolve) => {
		let done = false;
		let opened = false;
		let codeAsked = false;
		let codeBusy = false;
		let timers = [];
		let sock;

		const finish = async (result) => {
			if (done) return;
			done = true;
			timers.forEach(clearTimeout);
			try { sock.ev.removeAllListeners('connection.update'); } catch (e) { /* ignore */ }
			try { sock.end(undefined); } catch (e) { /* ignore */ }
			resolve(result);
		};

		(async () => {
			let version;
			try { version = (await api.fetchLatestBaileysVersion()).version; } catch (e) { version = undefined; }
			sock = api.makeWASocket({
				version,
				logger: silentLogger,
				browser: api.Browsers ? api.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
				auth: {
					creds: state.creds,
					keys: api.makeCacheableSignalKeyStore ? api.makeCacheableSignalKeyStore(state.keys, silentLogger) : state.keys,
				},
				markOnlineOnConnect: false,
				syncFullHistory: false,
			});
			hooks.onSocket(sock);

			sock.ev.on('creds.update', (update) => Object.assign(state.creds, update));

			const requestCode = async (quiet) => {
				if (mode !== 'pair' || codeAsked || codeBusy || done || opened || isLinked(state.creds)) return;
				codeBusy = true;
				try {
					const code = await sock.requestPairingCode(phone);
					codeAsked = true;
					hooks.onCode(code);
				} catch (e) {
					if (!quiet) {
						log('could not get a pairing code:', e.message);
						codeBusy = false;
						return finish('nocode');
					}
				}
				codeBusy = false;
			};

			sock.ev.on('connection.update', async (update) => {
				const { connection, lastDisconnect, qr } = update;
				if (qr) {
					if (mode === 'pair') await requestCode(false);
					else hooks.onQR(qr); // QR refreshes every ~20-60s until scanned; forward every one
				}

				if (connection === 'open') {
					opened = true;
					if (!isLinked(state.creds)) return finish('retry'); // opened without a real login: should not happen
					await sleep(SETTLE_MS);

					// save the session (via the site) and send the SESSION_ID to the user's own WhatsApp chat
					let linkResult;
					try {
						linkResult = await hooks.onLinked(state.exportAll());
					} catch (e) {
						log('could not save the session:', e.message);
						return finish('savefail');
					}
					if (linkResult && linkResult.message) {
						const selfJid = String(state.creds.me.id).split(':')[0] + '@s.whatsapp.net';
						try {
							await sock.sendMessage(selfJid, { text: linkResult.message });
						} catch (e) {
							log('could not deliver the SESSION_ID to WhatsApp:', e.message); // the web page still shows it
						}
					}
					return finish('paired');
				}

				if (connection === 'close') {
					const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
						? lastDisconnect.error.output.statusCode
						: undefined;
					if (status === (api.DisconnectReason.restartRequired || 515)) return finish('restart'); // normal right after a pairing code is entered
					if (status === (api.DisconnectReason.loggedOut || 401)) return finish('reset');
					return finish('retry');
				}
			});

			// some versions do not send "qr" before we can ask for a code
			if (mode === 'pair') timers.push(setTimeout(() => requestCode(true), 4000));
			timers.push(setTimeout(() => finish('retry'), SOCKET_TIMEOUT_MS));
		})().catch((e) => {
			log('socket error:', e.message);
			finish('error');
		});
	});
}

function startLinking(mode, phone, hooks) {
	let cancelled = false;
	let currentSock = null;
	const stop = () => {
		cancelled = true;
		try { currentSock && currentSock.end(undefined); } catch (e) { /* ignore */ }
	};

	(async () => {
		const api = await getApi();
		const state = memoryAuthState(api);
		const socketHooks = {
			onSocket: (s) => { currentSock = s; },
			onCode: (code) => hooks.onCode(code),
			onQR: (qr) => hooks.onQR(qr),
			onLinked: (sessionJson) => hooks.onLinked(sessionJson),
		};

		for (let i = 1; i <= MAX_SOCKETS && !cancelled; i++) {
			const result = await runSocket(api, state, mode, phone, socketHooks);
			if (cancelled) return;
			if (result === 'paired') return; // onLinked + the WhatsApp message were already handled inside runSocket
			if (result === 'restart') { await sleep(300); continue; }
			if (result === 'nocode') return hooks.onFail('Could not get a pairing code. Check the number (country code, no +) and try again.');
			if (result === 'reset') return hooks.onFail('WhatsApp refused the login. Please try again.');
			if (result === 'savefail') return hooks.onFail('Could not save the session. Please try again.');
			return hooks.onFail(mode === 'qr' ? 'The QR code expired. Please try again.' : 'The code expired or the connection dropped. Please try again.');
		}
		if (!cancelled) hooks.onFail('Could not finish linking. Please try again.');
	})().catch((e) => {
		log('error:', e.message);
		hooks.onFail('Something went wrong. Please try again.');
	});

	return { stop };
}

const startPairing = (phone, hooks) => startLinking('pair', phone, hooks);
const startQrLogin = (hooks) => startLinking('qr', null, hooks);

module.exports = { startPairing, startQrLogin };
