const http = require('http');

/**
 * A mock SMS provider that speaks both the Twilio Messages API shape and the
 * Fast2SMS bulk endpoint shape, so the real request-building code can be
 * exercised without a paid account and without sending anything.
 */
function createFakeSmsProvider(options = {}) {
  const received = [];
  const expectedAuth = options.expectedAuth || null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const isTwilio = /\/Messages\.json$/.test(req.url) || /\/Accounts\/[^/]+\.json$/.test(req.url);

      received.push({
        url: req.url,
        method: req.method,
        // Both providers carry their credential in the `authorization` header
        authorization: req.headers.authorization || null,
        body,
        params: Object.fromEntries(new URLSearchParams(body))
      });

      if (options.offline) {
        return res.destroy();
      }

      if (expectedAuth && req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ code: 20003, message: 'Authentication Error - invalid username' }));
      }

      // Twilio account lookup (used by gateway verification). GET, no body.
      if (req.method === 'GET' && /\/Accounts\/[^/]+\.json$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sid: 'AC00000000000000000000000000000000', status: 'active' }));
      }

      // Fast2SMS wallet lookup (used by gateway verification)
      if (req.method === 'GET' && /\/wallet$/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ return: true, wallet: '500.00' }));
      }

      if (!isTwilio) {
        // Fast2SMS bulk send
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ return: true, request_id: 'fast2sms-test-request', message: ['Message sent successfully'] }));
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: 'SM00000000000000000000000000000000', status: 'queued' }));
    });
  });

  return {
    received,
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { createFakeSmsProvider };
