// Test-only TLS: the bridge talks to its relay over wss:// only (checkRelay), so local tests need a
// certificate. This builds a throwaway self-signed ECDSA P-256 certificate for localhost / 127.0.0.1
// in memory (minimal DER encoder, no openssl). Nothing is written outside the caller's temp folder and
// TLS checks stay ON: the test trusts this one certificate (tls.setDefaultCACertificates in-process,
// NODE_EXTRA_CA_CERTS for child processes).
import crypto from 'node:crypto';

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) { const bytes = [v & 0x7f]; while ((v >>= 7)) bytes.unshift(0x80 | (v & 0x7f)); out.push(...bytes); }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));

/** → { key, cert } (PEM strings) valid for localhost and 127.0.0.1, one day back to one day ahead. */
export function selfSignedCert(cn = 'localhost') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),                        // v3
    tlv(0x02, Buffer.concat([Buffer.from([1 + crypto.randomInt(0x7e)]), crypto.randomBytes(7)])), // positive, minimal DER
    ECDSA_SHA256, name(cn),
    seq(utc(new Date(now - 86400000)), utc(new Date(now + 86400000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(san)),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sig));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem };
}
