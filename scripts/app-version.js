'use strict';

const fs = require('fs');
const path = require('path');

const VERSION_FILE = path.join(process.cwd(), 'version.json');

/** @type {{ version: string, mtimeMs: number }} */
let cache = { version: 'unknown', mtimeMs: -1 };

function readAppVersion() {
  try {
    const stat = fs.statSync(VERSION_FILE);
    if (stat.mtimeMs !== cache.mtimeMs) {
      const raw = fs.readFileSync(VERSION_FILE, 'utf8');
      const data = JSON.parse(raw);
      const version = String(data && data.version != null ? data.version : '').trim();
      cache = {
        version: version || 'unknown',
        mtimeMs: stat.mtimeMs,
      };
    }
  } catch (err) {
    cache = { version: 'unknown', mtimeMs: 0 };
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[app-version] could not read version.json:', err && err.message ? err.message : err);
    }
  }
  return cache.version;
}

module.exports = {
  VERSION_FILE,
  readAppVersion,
};
