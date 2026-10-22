const net = require('net');

/**
 * A tiny in-process SMTP server so email tests never touch a real mail server.
 *
 * It speaks just enough of the protocol for nodemailer to complete a session:
 * greeting, EHLO, optional STARTTLS refusal, AUTH, MAIL/RCPT/DATA.
 * Captured messages land in `received`.
 */
function createFakeSmtpServer(options = {}) {
  const credentials = options.credentials || { user: 'test@example.com', pass: 'test-password' };
  const received = [];

  const server = net.createServer((socket) => {
    // SMTP state is per connection: two concurrent sends must never share an envelope
    const state = {};
    state.inData = false;
    state.data = '';
    state.envelope = { from: null, to: [] };
    state.authenticated = !options.requireAuth;

    const send = (line) => socket.write(`${line}\r\n`);

    send(`220 fake-smtp.local ESMTP ready`);

    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');

      if (state.inData) {
        state.data += text;
        if (state.data.includes('\r\n.\r\n')) {
          state.inData = false;
          const body = state.data.slice(0, state.data.indexOf('\r\n.\r\n'));
          received.push({
            from: state.envelope.from,
            to: state.envelope.to,
            raw: body
          });
          state.data = '';
          state.envelope = { from: null, to: [] };
          send('250 2.0.0 Ok: queued');
        }
        return;
      }

      text.split('\r\n').filter(Boolean).forEach((line) => {
        const command = line.toUpperCase();

        if (options.rejectAuth && command.startsWith('AUTH')) {
          return send('535 5.7.8 Authentication credentials invalid');
        }

        if (options.rejectConnection) {
          return send('421 4.3.2 Service not available');
        }

        if (command.startsWith('EHLO') || command.startsWith('HELO')) {
          send('250-fake-smtp.local');
          send('250-AUTH PLAIN LOGIN');
          return send('250 8BITMIME');
        }

        if (command.startsWith('AUTH')) {
          if (options.requireAuth && line.includes('PLAIN')) {
            const encoded = line.split(' ')[2] || '';
            const decoded = Buffer.from(encoded, 'base64').toString('utf8').split('\0');
            const user = decoded[1];
            const pass = decoded[2];
            if (user !== credentials.user || pass !== credentials.pass) {
              return send('535 5.7.8 Authentication credentials invalid');
            }
            state.authenticated = true;
            return send('235 2.7.0 Authentication successful');
          }
          if (options.requireAuth && line.includes('LOGIN')) {
            return send('334 VXNlcm5hbWU6');
          }
          state.authenticated = true;
          return send('235 2.7.0 Authentication successful');
        }

        if (command.startsWith('MAIL FROM')) {
          state.envelope.from = line.replace(/^MAIL FROM:\s*/i, '').replace(/[<>]/g, '');
          return send('250 2.1.0 Ok');
        }

        if (command.startsWith('RCPT TO')) {
          state.envelope.to.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, ''));
          return send('250 2.1.5 Ok');
        }

        if (command.startsWith('DATA')) {
          state.inData = true;
          return send('354 End data with <CR><LF>.<CR><LF>');
        }

        if (command.startsWith('QUIT')) {
          send('221 2.0.0 Bye');
          return socket.end();
        }

        if (command.startsWith('RSET')) {
          state.envelope = { from: null, to: [] };
          return send('250 2.0.0 Ok');
        }

        return send('250 2.0.0 Ok');
      });
    });

    socket.on('error', () => { /* client aborted — ignore */ });
  });

  return {
    received,
    listen: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
    // Look up a captured message by recipient, with the body best-effort decoded
    messagesTo: (address) => received
      .filter((m) => m.to.includes(address))
      .map((m) => ({ ...m, ...decodeMessage(m.raw) }))
  };
}

/** Splits a raw SMTP message into headers and a best-effort decoded body. */
function decodeMessage(raw) {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator === -1) return { headers: raw, text: '', html: '' };

  // Unfold: a header continued on the next line starts with whitespace
  const headerBlock = raw.slice(0, separator).replace(/\r\n\s+/g, ' ');
  const body = raw.slice(separator + 4);
  const headers = headerBlock.split('\r\n');

  const headerValue = (name) => {
    const line = headers.find((h) => h.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line ? decodeEncodedWords(line.slice(line.indexOf(':') + 1).trim()) : null;
  };

  const decodePart = (content, encoding) => {
    if (!encoding) return content;
    if (/base64/i.test(encoding)) {
      try {
        return Buffer.from(content.replace(/\r\n/g, ''), 'base64').toString('utf8');
      } catch (error) { return content; }
    }
    if (/quoted-printable/i.test(encoding)) {
      return content
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    return content;
  };

  const isMultipart = /multipart/i.test(headerValue('Content-Type') || '');

  if (!isMultipart) {
    return {
      headers: headerBlock,
      subject: headerValue('Subject'),
      text: decodePart(body, headerValue('Content-Transfer-Encoding')),
      html: ''
    };
  }

  // Multipart: pull out the text/plain and text/html sections
  const parts = body.split(/--[^\r\n]+/).filter((part) => /content-type:/i.test(part));
  const partBody = (type) => {
    const part = parts.find((p) => new RegExp(`content-type:\\s*${type}`, 'i').test(p));
    if (!part) return '';
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) return '';
    const partHeaders = part.slice(0, split);
    const encoding = (partHeaders.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1];
    return decodePart(part.slice(split + 4).replace(/\r\n$/, ''), encoding);
  };

  return {
    headers: headerBlock,
    subject: headerValue('Subject'),
    text: partBody('text/plain'),
    html: partBody('text/html')
  };
}

module.exports = { createFakeSmtpServer, decodeMessage, decodeEncodedWords };

/**
 * Decodes RFC 2047 encoded words (=?UTF-8?Q?...?= / =?UTF-8?B?...?=), which is how
 * nodemailer transmits any subject containing quotes or non-ASCII characters.
 */
function decodeEncodedWords(value) {
  if (!value) return value;

  return value
    .replace(/\?=\s+=\?/g, '?==?')  // rejoin words split across folded lines
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, content) => {
      try {
        if (/b/i.test(encoding)) {
          return Buffer.from(content, 'base64').toString('utf8');
        }
        const bytes = content
          .replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
        return Buffer.from(bytes, 'binary').toString('utf8');
      } catch (error) {
        return match;
      }
    });
}
