'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'phase2-assembly-testing.js');
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf('  async function startVacuumTest(machine, opts = {})');
const end = s.indexOf('  async function appendTestAttemptNote(opts = {})');
if (start < 0 || end < 0) {
  console.error('markers', start, end);
  process.exit(1);
}

const replacement = fs.readFileSync(path.join(__dirname, 'tmp-testing-workflow-body.js'), 'utf8');
fs.writeFileSync(p, s.slice(0, start) + replacement + s.slice(end));
console.log('OK vacuum/brine/testing complete replaced');
