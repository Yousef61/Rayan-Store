'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, getSettings, setSetting } = require('./db');

// Secret used to sign the admin session cookie. Kept in the data folder so sessions survive restarts.
const secretFile = path.join(DATA_DIR, 'secret.key');
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}

const COOKIE = 'rayan_admin';
const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

// First run: create the admin password from ADMIN_PASSWORD (or a default that must be changed).
if (!getSettings().admin_password_hash) {
  const initial = process.env.ADMIN_PASSWORD || 'rayan123';
  setSetting('admin_password_hash', hashPassword(initial));
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('⚠️  Admin password is the default "rayan123". Change it from لوحة التحكم ← الإعدادات.');
  }
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex');
}

function makeToken() {
  // The password hash is part of the signed payload, so changing the password logs out all sessions.
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const pw = getSettings().admin_password_hash.slice(0, 16);
  return `${exp}.${sign(`${exp}.${pw}`)}`;
}

function checkToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const pw = getSettings().admin_password_hash.slice(0, 16);
  const expected = Buffer.from(sign(`${exp}.${pw}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function isAdmin(req) {
  return checkToken(readCookie(req, COOKIE));
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'يجب تسجيل الدخول' });
}

// Very small brute-force protection for the login endpoint.
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, until: 0 };
  return a.until < now || a.count < 5;
}
function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) attempts.set(ip, { count: 1, until: now + 15 * 60e3 });
  else a.count++;
}
function clearFailures(ip) {
  attempts.delete(ip);
}

module.exports = {
  hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, isAdmin, requireAdmin,
  loginAllowed, recordFailure, clearFailures,
};
