'use strict';
// Минимальный клиент протокола ACME v2 (RFC 8555) — получает настоящий,
// доверенный браузерами TLS-сертификат от Let's Encrypt автоматически, без
// установки сторонних npm-пакетов (только встроенные crypto/https/child_process,
// как и весь остальной проект) и без каких-либо ключей/аккаунтов, которые
// нужно было бы заводить вручную разработчику или админу сервера.
//
// Поддерживается только http-01 challenge (не требует доступа к DNS —
// только чтобы порт 80 сервера был доступен снаружи, что почти всегда и
// так есть на публичном сервере).
//
// Как это устроено, коротко:
//  1. Генерируем (один раз, локально) ключ ACME-аккаунта — просто ключевая
//     пара ECDSA, не требует регистрации где-либо вручную.
//  2. Регистрируем аккаунт в Let's Encrypt (тоже автоматически, без email
//     обязателен, соглашение с условиями принимается программно).
//  3. Заказываем сертификат на нужный домен/адрес.
//  4. Let's Encrypt просит доказать владение доменом — отвечаем, отдавая
//     специальный файл по http (см. registerChallenge/httpChallengeMiddleware).
//  5. Как только Let's Encrypt подтвердил владение — отправляем CSR
//     (через openssl, как и самоподписанный сертификат) и получаем готовый
//     сертификат.

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LETSENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Канонический JWK для аккаунта (порядок полей ВАЖЕН для thumbprint — см. RFC 7638)
function accountJwk(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
}

function jwkThumbprint(publicKey) {
  const jwk = accountJwk(publicKey);
  const canonical = JSON.stringify(jwk); // ключи уже в нужном (алфавитном) порядке
  return b64url(crypto.createHash('sha256').update(canonical).digest());
}

function httpsRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'http:' ? http : https;
    const req = transport.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { /* не JSON — ок, например сам сертификат в PEM */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('ACME request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class AcmeClient {
  constructor({ directoryUrl = LETSENCRYPT_DIRECTORY, accountKeyPath, log = () => {} } = {}) {
    this.directoryUrl = directoryUrl;
    this.accountKeyPath = accountKeyPath;
    this.log = log;
    this.nonce = null;
    this.kid = null; // выдаётся сервером ACME после регистрации аккаунта
  }

  async init() {
    const dirResp = await httpsRequest('GET', this.directoryUrl);
    if (!dirResp.json) throw new Error('Не удалось получить ACME directory: ' + dirResp.status);
    this.directory = dirResp.json;

    if (fs.existsSync(this.accountKeyPath)) {
      const pem = fs.readFileSync(this.accountKeyPath, 'utf8');
      this.privateKey = crypto.createPrivateKey(pem);
      this.publicKey = crypto.createPublicKey(pem);
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.publicKey = publicKey;
      this.privateKey = privateKey;
      fs.mkdirSync(path.dirname(this.accountKeyPath), { recursive: true });
      fs.writeFileSync(this.accountKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
  }

  async freshNonce() {
    if (this.nonce) { const n = this.nonce; this.nonce = null; return n; }
    const resp = await httpsRequest('HEAD', this.directory.newNonce);
    return resp.headers['replay-nonce'];
  }

  // Подписывает ACME-запрос (JWS, ES256) — либо своим публичным ключом
  // (для самого первого запроса — регистрации аккаунта), либо через kid
  // (для всех последующих, когда аккаунт уже известен серверу).
  async signedRequest(url, payload) {
    const nonce = await this.freshNonce();
    const protectedHeader = this.kid
      ? { alg: 'ES256', kid: this.kid, nonce, url }
      : { alg: 'ES256', jwk: accountJwk(this.publicKey), nonce, url };
    const protectedB64 = b64url(JSON.stringify(protectedHeader));
    const payloadB64 = payload === '' ? '' : b64url(JSON.stringify(payload));
    const signingInput = `${protectedB64}.${payloadB64}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    const body = JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64url(signature) });

    const resp = await httpsRequest('POST', url, {
      headers: { 'Content-Type': 'application/jose+json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    if (resp.headers['replay-nonce']) this.nonce = resp.headers['replay-nonce'];
    if (resp.status >= 400) {
      const problem = resp.json ? JSON.stringify(resp.json) : resp.body;
      throw new Error(`ACME ${url} → ${resp.status}: ${problem}`);
    }
    return resp;
  }

  async ensureAccount() {
    const resp = await this.signedRequest(this.directory.newAccount, { termsOfServiceAgreed: true });
    this.kid = resp.headers.location;
  }

  // registerChallenge(token, keyAuth) / unregisterChallenge(token) — коллбэки,
  // которыми вызывающий код (server.js) регистрирует/убирает содержимое
  // для HTTP-эндпоинта /.well-known/acme-challenge/<token>.
  async obtainCertificate({ domain, registerChallenge, unregisterChallenge, waitForServerReady }) {
    await this.init();
    await this.ensureAccount();

    const orderResp = await this.signedRequest(this.directory.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    const order = orderResp.json;
    const orderUrl = orderResp.headers.location;
    const authzUrl = order.authorizations[0];

    const authzResp = await this.signedRequest(authzUrl, '');
    const authz = authzResp.json;
    const challenge = (authz.challenges || []).find((c) => c.type === 'http-01');
    if (!challenge) throw new Error('Сервер ACME не предложил http-01 challenge (возможно, нужен другой тип проверки)');

    const keyAuth = `${challenge.token}.${jwkThumbprint(this.publicKey)}`;
    registerChallenge(challenge.token, keyAuth);
    try {
      if (waitForServerReady) await waitForServerReady();

      // Сообщаем ACME, что можно проверять
      await this.signedRequest(challenge.url, {});

      // Ждём подтверждения (poll authorization status)
      let status = authz.status;
      for (let i = 0; i < 20 && status !== 'valid' && status !== 'invalid'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await this.signedRequest(authzUrl, '');
        status = check.json.status;
      }
      if (status !== 'valid') {
        throw new Error('Let\'s Encrypt не смог подтвердить владение доменом (http-01 challenge не прошёл) — проверьте, что порт 80 доступен снаружи и домен реально указывает на этот сервер');
      }
    } finally {
      unregisterChallenge(challenge.token);
    }

    // CSR — через openssl (тот же подход, что и для самоподписанного сертификата)
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'acme-'));
    const csrKeyPath = path.join(tmpDir, 'domain-key.pem');
    const csrPath = path.join(tmpDir, 'domain.csr');
    try {
      execSync(`openssl ecparam -genkey -name prime256v1 -noout -out "${csrKeyPath}"`, { stdio: 'ignore' });
      execSync(`openssl req -new -key "${csrKeyPath}" -subj "/CN=${domain}" -out "${csrPath}"`, { stdio: 'ignore' });
      const csrDer = execSync(`openssl req -in "${csrPath}" -outform DER`);
      const csrB64url = b64url(csrDer);

      const finalizeResp = await this.signedRequest(order.finalize, { csr: csrB64url });
      let finalOrder = finalizeResp.json;
      for (let i = 0; i < 20 && finalOrder.status !== 'valid'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await this.signedRequest(orderUrl, '');
        finalOrder = check.json;
        if (finalOrder.status === 'invalid') throw new Error('ACME order стал invalid при финализации: ' + JSON.stringify(finalOrder));
      }
      if (finalOrder.status !== 'valid' || !finalOrder.certificate) {
        throw new Error('Не удалось дождаться готового сертификата от ACME (order status: ' + finalOrder.status + ')');
      }

      const certResp = await this.signedRequest(finalOrder.certificate, '');
      const certPem = certResp.body;
      const keyPem = fs.readFileSync(csrKeyPath, 'utf8');
      return { certPem, keyPem };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

module.exports = { AcmeClient, LETSENCRYPT_DIRECTORY, b64url, jwkThumbprint, accountJwk };
