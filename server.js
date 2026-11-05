'use strict';

/**
 * cc-deploy-listener — webhook de deploy continuo del ecosistema Dotrino.
 *
 * Escucha webhooks `push` de GitHub, valida la firma HMAC (X-Hub-Signature-256)
 * con un secreto compartido, y por cada repo configurado hace un pull idempotente
 * + restart del servicio systemd correspondiente:
 *
 *     git fetch origin <branch> && git reset --hard origin/<branch>
 *     [npm <ci|install ...>]            (opcional)
 *     sudo -n systemctl restart <unit>  (requiere NOPASSWD para ese unit)
 *     [curl <healthUrl>]                (opcional, solo log)
 *
 * Sin dependencias externas (solo stdlib): http + crypto + child_process + fs.
 * Los deploys se serializan (cola) para que dos webhooks no colisionen.
 *
 * Config: JSON apuntado por CC_DEPLOY_CONFIG (default ./deploy.config.json).
 * Ver deploy.config.example.json.
 */

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');

const CONFIG_PATH = process.env.CC_DEPLOY_CONFIG || './deploy.config.json';

/**
 * @typedef {object} RepoConfig
 * @property {string} dir       checkout en disco
 * @property {string} branch    rama que se despliega
 * @property {string} [npm]     argumentos de `npm` tras el pull (p. ej. `ci --omit=dev`)
 * @property {string} [unit]    unit de systemd a reiniciar
 * @property {string} [pm2]     app de pm2 a reiniciar
 * @property {string} [healthUrl]
 *
 * @typedef {object} DeployConfig
 * @property {string} secret
 * @property {Record<string, RepoConfig>} repos
 * @property {number} port
 * @property {string} host
 * @property {string} path
 * @property {string} [logFile]
 */

/** @returns {DeployConfig} */
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.secret || cfg.secret === 'CHANGE_ME') throw new Error('config.secret missing or left at the default');
  if (!cfg.repos || typeof cfg.repos !== 'object') throw new Error('config.repos is missing');
  cfg.port = cfg.port || 9099;
  cfg.host = cfg.host || '127.0.0.1';
  cfg.path = cfg.path || '/hooks/deploy';
  return cfg;
}

let cfg = loadConfig();

function ts() { return new Date().toISOString(); }
/** @param {string} msg */
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  if (cfg.logFile) { try { fs.appendFileSync(cfg.logFile, line + '\n'); } catch (_) {} }
}

// ---- deploy queue (serializa todos los deploys) --------------------------
let chain = Promise.resolve();
/**
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
function enqueue(label, fn) {
  chain = chain.then(fn).catch((e) => log(`deploy ${label} ERROR: ${e.message}${e.stderr ? ' :: ' + String(e.stderr).slice(0, 400) : ''}`));
  return chain;
}

/**
 * @typedef {Error & { stdout?: string, stderr?: string }} RunError
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptions} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { const e = /** @type {RunError} */ (err); e.stdout = String(stdout); e.stderr = String(stderr); reject(e); }
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
// Ejecuta un script cargando nvm explícitamente: el ~/.bashrc de muchos hosts
// corta temprano en shells no-interactivos y NO deja node/npm/pm2 en el PATH.
// Sourceamos nvm a mano para que npm/pm2 resuelvan siempre (git es del sistema).
/**
 * @param {string} script
 * @param {string} cwd
 */
function bashlc(script, cwd) {
  const nvm = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ';
  return run('bash', ['-lc', nvm + script], { cwd });
}

/**
 * @param {string} name
 * @param {RepoConfig} r
 */
async function deploy(name, r) {
  if (!r.dir || !r.branch) throw new Error(`repo ${name} has no dir/branch`);
  log(`deploy ${name} → ${r.dir} (branch ${r.branch}${r.unit ? ', unit ' + r.unit : ''})`);
  await bashlc(`git fetch origin ${r.branch}`, r.dir);
  await bashlc(`git reset --hard origin/${r.branch}`, r.dir);
  if (r.npm) await bashlc(`npm ${r.npm}`, r.dir);
  // Restart: por systemd (sudo, requiere NOPASSWD) o por pm2 (sin sudo). Un repo
  // declara `unit` (systemd) o `pm2` (nombre de la app pm2), no ambos.
  if (r.pm2) await bashlc(`pm2 restart ${r.pm2}`, r.dir);
  else if (r.unit) await run('sudo', ['-n', 'systemctl', 'restart', r.unit]);
  const how = r.pm2 ? 'pm2 restart ' + r.pm2 : r.unit ? 'restarted ' + r.unit : 'no restart';
  log(`deploy ${name} OK (${how})`);
  if (r.healthUrl) {
    try { await bashlc(`curl -fsS -m 8 ${r.healthUrl} >/dev/null`, r.dir); log(`health ${name} OK`); }
    catch (_) { log(`health ${name} FAIL (${r.healthUrl})`); }
  }
}

// ---- HMAC verify ----------------------------------------------------------
/**
 * @param {Buffer} rawBody
 * @param {string | string[] | undefined} header
 * @returns {boolean}
 */
function validSignature(rawBody, header) {
  if (typeof header !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- HTTP server ----------------------------------------------------------
const server = http.createServer((req, res) => {
  /** @param {number} code @param {object} obj */
  const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, service: 'cc-deploy-listener' });
  if (req.method !== 'POST' || (req.url || '').split('?')[0] !== cfg.path) return reply(404, { error: 'not found' });

  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!validSignature(raw, req.headers['x-hub-signature-256'])) {
      log(`rejected: invalid signature (${req.socket.remoteAddress})`);
      return reply(401, { error: 'invalid signature' });
    }
    const event = req.headers['x-github-event'];
    if (event === 'ping') return reply(200, { pong: true });
    if (event !== 'push') return reply(204, { ignored: event });

    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch (_) { return reply(400, { error: 'bad json' }); }
    const repoName = payload.repository && payload.repository.full_name;
    const ref = payload.ref;
    const r = repoName && cfg.repos[repoName];
    if (!r) return reply(202, { ignored: 'repo not configured', repo: repoName });
    if (ref !== `refs/heads/${r.branch}`) return reply(202, { ignored: 'branch not deployed', ref });

    enqueue(repoName, () => deploy(repoName, r));
    log(`queued deploy ${repoName} (${ref})`);
    return reply(202, { queued: true, repo: repoName });
  });
});

server.listen(cfg.port, cfg.host, () => {
  log(`cc-deploy-listener listening on http://${cfg.host}:${cfg.port}${cfg.path} — repos: ${Object.keys(cfg.repos).join(', ')}`);
  // §15: no usa pilares, así que lo que se le queda atrás es el checkout. Justo este servicio
  // corría en los dos VPS una copia de junio que no era un clon de git, y nadie lo veía.
  import('@dotrino/update/checkout')
    .then(({ watchCheckout }) => watchCheckout({ dir: __dirname, repo: 'imdotrino/dotrino-deploy-listener', name: 'deploy-listener', log }))
    .catch((e) => log(`[update] could not start the watch: ${e.code || e.message}`));
});

// Recarga de config con SIGHUP (sin reiniciar el servicio).
process.on('SIGHUP', () => {
  try { cfg = loadConfig(); log('config reloaded (SIGHUP)'); }
  catch (e) { log(`config reload failed: ${/** @type {Error} */ (e).message}`); }
});
process.on('SIGTERM', () => { log('SIGTERM, shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
