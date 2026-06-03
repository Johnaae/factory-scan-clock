'use strict';

const path = require('path');
const dotenv = require('dotenv');

/** Base env, then .env.local overrides (standard local dev pattern). */
dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '.env.local'), override: true });
