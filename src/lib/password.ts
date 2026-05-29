import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const keyLength = 64;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, keyLength).toString('hex');

  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, hash] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
