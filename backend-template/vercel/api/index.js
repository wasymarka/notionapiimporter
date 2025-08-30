// Minimal backend template for Vercel serverless functions
// Routes:
// - GET /api/a/start
// - GET /api/a/pause
// - GET /api/a/stop
// Query params: taskId, tasksDbId, calendarDbId, ts, nonce, sig
// HMAC signature: sha256(secret, `${taskId}|${action}|${ts}|${nonce}|${tasksDbId}|${calendarDbId}`)

const crypto = require('crypto');
const { Client } = require('@notionhq/client');

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifySignature(secret, query) {
  const { sig, action, taskId, ts, nonce, tasksDbId, calendarDbId } = query;
  if (!sig || !action || !taskId || !ts || !nonce) return false;
  const payload = [taskId, action, ts, nonce, tasksDbId || '', calendarDbId || ''].join('|');
  const expected = hmacSign(secret, payload);
  return expected === sig;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function bad(res, status, message) {
  return json(res, status, { error: message });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        if (!data) return resolve(null);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) return resolve(JSON.parse(data));
        resolve(data);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleAction(action, req, res) {
  const secret = process.env.APP_SECRET;
  const notionToken = process.env.NOTION_TOKEN;
  if (!secret) return bad(res, 500, 'Missing APP_SECRET');
  if (!notionToken) return bad(res, 500, 'Missing NOTION_TOKEN');
  if (!verifySignature(secret, req.query)) return bad(res, 401, 'Invalid signature');

  const { taskId, tasksDbId, calendarDbId } = req.query;
  const notion = new Client({ auth: notionToken });

  // Fetch task page
  const task = await notion.pages.retrieve({ page_id: taskId });
  const props = task.properties || {};

  const nowIso = new Date().toISOString();
  const statusProp = props['Status'];
  const runningProp = props['Timer Running'];
  const lastStartedProp = props['Last Started At'];
  const totalProp = props['Total Tracked (min)'];

  function statusTo(name) {
    if (!statusProp || statusProp.type !== 'status') return undefined;
    return { status: { name } };
  }

  async function updateTaskProperties(update) {
    await notion.pages.update({ page_id: taskId, properties: update });
  }

  // Helper to compute duration minutes between last start and now, accumulate into Total Tracked
  function computeAccumulatedMinutes(lastIso, total = 0) {
    try {
      if (!lastIso) return total;
      const from = new Date(lastIso).getTime();
      const to = Date.now();
      const diffMin = Math.max(0, Math.round((to - from) / 60000));
      return (total || 0) + diffMin;
    } catch (_) { return total || 0; }
  }

  if (action === 'start') {
    await updateTaskProperties({
      ...(statusProp ? statusTo('In Progress') : {}),
      ...(runningProp ? { 'Timer Running': { checkbox: true } } : {}),
      ...(lastStartedProp ? { 'Last Started At': { date: { start: nowIso } } } : {}),
    });
    return json(res, 200, { ok: true, action, at: nowIso });
  }

  if (action === 'pause') {
    const lastIso = lastStartedProp?.date?.start || lastStartedProp?.date?.end || null;
    const currentTotal = totalProp?.number || 0;
    const newTotal = computeAccumulatedMinutes(lastIso, currentTotal);
    await updateTaskProperties({
      ...(statusProp ? statusTo('Paused') : {}),
      ...(runningProp ? { 'Timer Running': { checkbox: false } } : {}),
      ...(lastStartedProp ? { 'Last Started At': { date: null } } : {}),
      ...(totalProp ? { 'Total Tracked (min)': { number: newTotal } } : {}),
    });
    return json(res, 200, { ok: true, action, totalMin: newTotal });
  }

  if (action === 'stop') {
    const lastIso = lastStartedProp?.date?.start || lastStartedProp?.date?.end || null;
    const currentTotal = totalProp?.number || 0;
    const newTotal = computeAccumulatedMinutes(lastIso, currentTotal);

    // Update task
    await updateTaskProperties({
      ...(statusProp ? statusTo('Done') : {}),
      ...(runningProp ? { 'Timer Running': { checkbox: false } } : {}),
      ...(lastStartedProp ? { 'Last Started At': { date: null } } : {}),
      ...(totalProp ? { 'Total Tracked (min)': { number: newTotal } } : {}),
    });

    // Create calendar entry if provided
    if (calendarDbId) {
      // Resolve title property name of tasks database
      const tasksDb = await notion.databases.retrieve({ database_id: tasksDbId });
      let taskTitlePropName = Object.entries(tasksDb.properties).find(([, p]) => p.type === 'title')?.[0] || 'Name';
      const taskTitle = task.properties?.[taskTitlePropName]?.title?.map(t => t.plain_text).join('') || 'Task';

      await notion.pages.create({
        parent: { database_id: calendarDbId },
        properties: {
          Name: { title: [{ type: 'text', text: { content: taskTitle } }] },
          'When': { date: { start: nowIso } },
          'Duration (min)': { number: newTotal },
          'Task': { relation: [{ id: taskId }] },
        },
      });
    }

    return json(res, 200, { ok: true, action, totalMin: newTotal });
  }

  return bad(res, 404, 'Unknown action');
}

module.exports = async (req, res) => {
  try {
    // Normalize query params for Vercel
    req.query = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname || '';
    if (!pathname.startsWith('/api')) {
      res.statusCode = 404; res.end('Not Found'); return;
    }
    // Action routes
    const actionMatch = pathname.match(/\/a\/(start|pause|stop)$/);
    const action = actionMatch ? actionMatch[1] : null;
    if (action) return await handleAction(action, req, res);

    // Webhook routes: POST /api/webhook/:name?secret=APP_SECRET
    const webhookMatch = pathname.match(/\/webhook\/([A-Za-z0-9_-]+)$/);
    if (webhookMatch) {
      if (req.method !== 'POST') return bad(res, 405, 'Method Not Allowed');
      const name = webhookMatch[1];
      const secret = process.env.APP_SECRET;
      const provided = url.searchParams.get('secret');
      if (!secret) return bad(res, 500, 'Missing APP_SECRET');
      if (!provided || provided !== secret) return bad(res, 401, 'Invalid secret');
      const body = await readBody(req);
      // You can add custom webhook handlers per name here
      return json(res, 200, { ok: true, webhook: name, received: body ? true : false });
    }

    return bad(res, 404, 'Route not found');
  } catch (e) {
    console.error(e);
    bad(res, 500, 'Internal error');
  }
};