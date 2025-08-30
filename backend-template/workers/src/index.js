// Cloudflare Workers style backend template
// Routes:
// - GET /a/start
// - GET /a/pause
// - GET /a/stop
// Env: APP_SECRET, NOTION_TOKEN

import crypto from 'node:crypto';
import { Client } from '@notionhq/client';

function hmacSign(secret, payload) { return crypto.createHmac('sha256', secret).update(payload).digest('hex'); }

function verifySignature(secret, url) {
  const u = new URL(url);
  const q = u.searchParams;
  const sig = q.get('sig');
  const action = q.get('action');
  const taskId = q.get('taskId');
  const ts = q.get('ts');
  const nonce = q.get('nonce');
  const tasksDbId = q.get('tasksDbId') || '';
  const calendarDbId = q.get('calendarDbId') || '';
  if (!sig || !action || !taskId || !ts || !nonce) return false;
  const payload = [taskId, action, ts, nonce, tasksDbId, calendarDbId].join('|');
  return hmacSign(secret, payload) === sig;
}

function json(status, body) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }

function computeAccumulatedMinutes(lastIso, total = 0) {
  try {
    if (!lastIso) return total;
    const from = new Date(lastIso).getTime();
    const to = Date.now();
    const diffMin = Math.max(0, Math.round((to - from) / 60000));
    return (total || 0) + diffMin;
  } catch (_) { return total || 0; }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/a/')) return json(404, { error: 'Not Found' });
      const action = url.pathname.split('/').pop();
      const secret = env.APP_SECRET;
      const notionToken = env.NOTION_TOKEN;
      if (!secret || !notionToken) return json(500, { error: 'Missing env' });
      if (!verifySignature(secret, request.url)) return json(401, { error: 'Invalid signature' });

      const taskId = url.searchParams.get('taskId');
      const tasksDbId = url.searchParams.get('tasksDbId') || '';
      const calendarDbId = url.searchParams.get('calendarDbId') || '';

      const notion = new Client({ auth: notionToken, fetch: (input, init) => fetch(input, init) });
      const task = await notion.pages.retrieve({ page_id: taskId });
      const props = task.properties || {};
      const nowIso = new Date().toISOString();

      const statusProp = props['Status'];
      const runningProp = props['Timer Running'];
      const lastStartedProp = props['Last Started At'];
      const totalProp = props['Total Tracked (min)'];

      function statusTo(name) { return statusProp && statusProp.type === 'status' ? { status: { name } } : undefined; }
      async function updateTaskProperties(update) { await notion.pages.update({ page_id: taskId, properties: update }); }

      if (action === 'start') {
        await updateTaskProperties({
          ...(statusProp ? statusTo('In Progress') : {}),
          ...(runningProp ? { 'Timer Running': { checkbox: true } } : {}),
          ...(lastStartedProp ? { 'Last Started At': { date: { start: nowIso } } } : {}),
        });
        return json(200, { ok: true, action, at: nowIso });
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
        return json(200, { ok: true, action, totalMin: newTotal });
      }

      if (action === 'stop') {
        const lastIso = lastStartedProp?.date?.start || lastStartedProp?.date?.end || null;
        const currentTotal = totalProp?.number || 0;
        const newTotal = computeAccumulatedMinutes(lastIso, currentTotal);

        await updateTaskProperties({
          ...(statusProp ? statusTo('Done') : {}),
          ...(runningProp ? { 'Timer Running': { checkbox: false } } : {}),
          ...(lastStartedProp ? { 'Last Started At': { date: null } } : {}),
          ...(totalProp ? { 'Total Tracked (min)': { number: newTotal } } : {}),
        });

        if (calendarDbId) {
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

        return json(200, { ok: true, action, totalMin: newTotal });
      }

      return json(404, { error: 'Unknown action' });
    } catch (e) {
      return json(500, { error: 'Internal error' });
    }
  }
};