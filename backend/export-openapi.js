// This file is auto-generated for API client generation and Postman import
const fs = require('fs');
const { swaggerSpec } = require('./src/config/swagger');

// Use shared logger so logs include requestId and redact sensitive fields
const { logger, installRequestIdConsolePatch } = require('./src/lib/logger');
installRequestIdConsolePatch();

fs.writeFileSync('./openapi.json', JSON.stringify(swaggerSpec, null, 2));
logger.info('openapi.json exported');
