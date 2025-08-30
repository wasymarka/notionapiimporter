#!/usr/bin/env node
// index.js - Notion Template Instantiator CLI

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const ora = require('ora');
const kleur = require('kleur');
const { Client } = require('@notionhq/client');
const crypto = require('crypto');
let yaml;
try { yaml = require('js-yaml'); } catch (_) { yaml = null; }

function ensureClient() {
  if (!notion) {
    const token = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
    if (!token) {
      throw new Error('\nMissing Notion token. Please create an internal integration at https://www.notion.so/my-integrations and set NOTION_TOKEN in a .env file.');
    }
    notion = new Client({ auth: token });
  }
  return notion;
}

// Simple concurrency limiter to run tasks with bounded parallelism
function createLimit(concurrency = 2) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency) return;
    const item = queue.shift();
    if (!item) return;
    active++;
    item.fn()
      .then((res) => item.resolve(res))
      .catch((err) => item.reject(err))
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (typeof setImmediate === 'function') setImmediate(next); else setTimeout(next, 0);
  });
}

const limit = createLimit(3);

async function withRetry(fn, label = 'notion-call') {
  let attempt = 0;
  let wait = 500;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const status = err?.status || err?.statusCode;
      if (attempt >= 5 || (status && status < 500 && status !== 429)) {
        throw err;
      }
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 2, 5000);
    }
  }
}

// Helpers
async function getAllBlocks(blockId) {
  ensureClient();
  const results = [];
  let cursor;
  do {
    const resp = await withRetry(() => ensureClient().blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 }));
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

function transformPropertiesToCreate(properties) {
  const out = {};
  for (const [name, prop] of Object.entries(properties || {})) {
    const { type } = prop;
    out[name] = { type };
    if (type === 'select' && prop.select?.options) {
      out[name].select = { options: prop.select.options.map(o => ({ name: o.name, color: o.color })) };
    }
    if (type === 'multi_select' && prop.multi_select?.options) {
      out[name].multi_select = { options: prop.multi_select.options.map(o => ({ name: o.name, color: o.color })) };
    }
    if (type === 'status' && prop.status?.options) {
      out[name].status = { options: prop.status.options.map(o => ({ name: o.name, color: o.color })) };
    }
  }
  return out;
}

function sanitizeBlocks(blocks) {
  return blocks
    .map(b => {
      const { type } = b;
      const base = { type };
      if (b[type]) base[type] = JSON.parse(JSON.stringify(b[type]));
      if (base[type]?.rich_text) {
        base[type].rich_text = base[type].rich_text.map(rt => ({ ...rt }));
      }
      if (b.has_children) {
        base.has_children = true;
      }
      return base;
    })
    .filter(Boolean);
}

async function cloneBlocksRecursive(sourceBlockId, targetParent, targetType = 'block_id') {
  ensureClient();
  const blocks = await getAllBlocks(sourceBlockId);
  const sanitized = sanitizeBlocks(blocks);
  const created = [];
  for (let i = 0; i < sanitized.length; i += 50) {
    const chunk = sanitized.slice(i, i + 50);
    const resp = await withRetry(() => ensureClient().blocks.children.append({
      [targetType]: targetParent,
      children: chunk,
    }));
    created.push(...resp.results);
  }
  await Promise.all(
    created.map((newBlock, idx) =>
      limit(async () => {
        const src = blocks[idx];
        if (src?.has_children) {
          await cloneBlocksRecursive(src.id, newBlock.id, 'block_id');
        }
      })
    )
  );
}

async function exportMaster(pageOrDbId) {
  ensureClient();
  try {
    const page = await withRetry(() => ensureClient().pages.retrieve({ page_id: pageOrDbId }));
    const blocks = await getAllBlocks(pageOrDbId);
    return { kind: 'page', page, blocks };
  } catch (e1) {
    try {
      const db = await withRetry(() => ensureClient().databases.retrieve({ database_id: pageOrDbId }));
      return { kind: 'database', database: db };
    } catch (e2) {
      throw new Error('ID is neither a Page nor a Database. Make sure the integration has access.');
    }
  }
}

// Helper to extract plain title text from a Page object
function getPageTitleText(page) {
  const props = page.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map(t => t.plain_text || t.text?.content || '').join('');
      if (text) return text;
    }
  }
  return 'Untitled';
}

// Build a portable JSON template from an existing page or database
async function exportToTemplate(id) {
  const master = await exportMaster(id);
  if (master.kind === 'page') {
    const title = getPageTitleText(master.page);
    const icon = master.page.icon || null;
    const cover = master.page.cover || null;
    const children = sanitizeBlocks(master.blocks || []);
    return {
      kind: 'page',
      title,
      icon,
      cover,
      children,
    };
  }
  if (master.kind === 'database') {
    const title = (master.database.title || []).map(t => t.plain_text || t.text?.content || '').join('') || 'Untitled DB';
    const icon = master.database.icon || null;
    const cover = master.database.cover || null;
    const properties = transformPropertiesToCreate(master.database.properties || {});
    return {
      kind: 'database',
      title,
      icon,
      cover,
      properties,
    };
  }
  throw new Error('Unsupported kind');
}

async function getDatabaseTitlePropName(databaseId) {
  ensureClient();
  const db = await withRetry(() => ensureClient().databases.retrieve({ database_id: databaseId }));
  for (const [name, prop] of Object.entries(db.properties)) {
    if (prop.type === 'title') return name;
  }
  return 'Name';
}

async function createFromJsonTemplate(templatePath, parent, parentType) {
  ensureClient();
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  if (tpl.kind === 'page') {
    const { title = 'Untitled', icon, cover, properties = {}, children = [] } = tpl;
    let pagePayload;
    if (parentType === 'page') {
      const titleProp = properties.title || { title: [{ type: 'text', text: { content: title } }] };
      pagePayload = {
        parent: { page_id: parent },
        properties: { title: titleProp.title ? titleProp : { title: [{ type: 'text', text: { content: title } }] } },
        icon,
        cover,
      };
    } else {
      pagePayload = {
        parent: { database_id: parent },
        properties,
        icon,
        cover,
      };
    }
    const created = await withRetry(() => ensureClient().pages.create(pagePayload));
    if (children.length) {
      for (let i = 0; i < children.length; i += 50) {
        await withRetry(() => ensureClient().blocks.children.append({ block_id: created.id, children: children.slice(i, i + 50) }));
      }
    }
    return created;
  } else if (tpl.kind === 'database') {
    if (parentType !== 'page') {
      throw new Error('Database templates must be created under a page (use --parentType page)');
    }
    const { title = 'Untitled DB', icon, cover, properties = {} } = tpl;
    const created = await withRetry(() => ensureClient().databases.create({
      parent: { page_id: parent },
      title: [{ type: 'text', text: { content: title } }],
      icon,
      cover,
      properties,
    }));
    return created;
  }
  throw new Error('Unknown template kind');
}

async function cloneFromMaster(masterId, targetParentId, mode) {
  ensureClient();
  const master = await exportMaster(masterId);
  if (master.kind === 'page') {
    const titleProp = master.page.properties?.title;
    const titleText = Array.isArray(titleProp?.title) && titleProp.title.length
      ? titleProp.title.map(t => t.plain_text).join('')
      : 'Cloned Page';

    if (mode === 'into_database') {
      const titleName = await getDatabaseTitlePropName(targetParentId);
      const newPage = await withRetry(() => ensureClient().pages.create({
        parent: { database_id: targetParentId },
        properties: {
          [titleName]: { title: [{ type: 'text', text: { content: titleText } }] },
        },
      }));
      await cloneBlocksRecursive(master.page.id, newPage.id, 'block_id');
      return newPage;
    } else {
      const newPage = await withRetry(() => ensureClient().pages.create({
        parent: { page_id: targetParentId },
        properties: { title: { title: [{ type: 'text', text: { content: titleText } }] } },
      }));
      await cloneBlocksRecursive(master.page.id, newPage.id, 'block_id');
      return newPage;
    }
  }
  if (master.kind === 'database') {
    // Validate target is a page for database cloning
    try {
      await withRetry(() => ensureClient().pages.retrieve({ page_id: targetParentId }));
    } catch (e) {
      throw new Error('When cloning a database, targetId must be a page_id (a page where the new database will be created).');
    }
    const schema = transformPropertiesToCreate(master.database.properties);
    const title = master.database.title?.map(t => t.plain_text).join('') || 'Cloned Database';
    const createdDb = await withRetry(() => ensureClient().databases.create({
      parent: { page_id: targetParentId },
      title: [{ type: 'text', text: { content: title } }],
      properties: schema,
    }));
    return createdDb;
  }
}

function assertIdLike(id, label) {
  if (!id || typeof id !== 'string' || id.length < 32) {
    throw new Error(`${label} looks invalid. Provide a 32+ char Notion ID (hyphens optional).`);
  }
}

async function main() {
  yargs(hideBin(process.argv))
    .scriptName('notion-template')
    .usage('$0 <cmd> [args]')
    .command('from-master <masterId> <targetId>', 'Clone an existing master page/database into a target location', (y) => {
      return y
        .positional('masterId', { describe: 'ID of existing Notion page or database to use as master', type: 'string' })
        .positional('targetId', { describe: 'Target page ID (for creating sub-page or new database) or database ID (to create page entry)', type: 'string' })
        .option('mode', { choices: ['under_page', 'into_database'], default: 'under_page', describe: 'under_page: create page/db under target page; into_database: create page inside target database' });
    }, async (args) => {
      const spinner = ora('Cloning from master...').start();
      try {
        assertIdLike(args.masterId, 'masterId');
        assertIdLike(args.targetId, 'targetId');
        const res = await cloneFromMaster(args.masterId, args.targetId, args.mode);
        spinner.succeed(kleur.green(`Created: ${res.url}`));
      } catch (err) {
        spinner.fail(kleur.red(err.message));
        process.exitCode = 1;
      }
    })
    .command('from-json <templatePath> <targetId>', 'Instantiate from a JSON template file', (y) => {
      return y
        .positional('templatePath', { describe: 'Path to JSON template', type: 'string' })
        .positional('targetId', { describe: 'Target page ID (for databases or sub-pages) or database ID (for page entries)', type: 'string' })
        .option('parentType', { choices: ['page', 'database'], demandOption: true, describe: 'Where to place the created object' });
    }, async (args) => {
      const spinner = ora('Creating from JSON template...').start();
      try {
        assertIdLike(args.targetId, 'targetId');
        const fullPath = path.resolve(process.cwd(), args.templatePath);
        if (!fs.existsSync(fullPath)) throw new Error('Template file not found');
        const res = await createFromJsonTemplate(fullPath, args.targetId, args.parentType);
        spinner.succeed(kleur.green(`Created: ${res.url || res.id}`));
      } catch (err) {
        spinner.fail(kleur.red(err.message));
        process.exitCode = 1;
      }
    })
    // New: export an existing page/database to a JSON template
    .command(['to-json <id> [outFile]', 'export-json <id> [outFile]'], 'Export existing page or database into a JSON template', (y) => {
      return y
        .positional('id', { describe: 'ID of a Notion page or database to export', type: 'string' })
        .positional('outFile', { describe: 'Optional output file path; if omitted, prints to stdout', type: 'string' })
        .option('pretty', { type: 'boolean', default: true, describe: 'Pretty-print JSON with indentation' });
    }, async (args) => {
      const spinner = ora('Exporting to JSON template...').start();
      try {
        assertIdLike(args.id, 'id');
        const tpl = await exportToTemplate(args.id);
        const json = JSON.stringify(tpl, null, args.pretty ? 2 : 0);
        if (args.outFile) {
          const outPath = path.resolve(process.cwd(), args.outFile);
          const dir = path.dirname(outPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(outPath, json, 'utf8');
          spinner.succeed(kleur.green(`Exported template to: ${outPath}`));
        } else {
          spinner.stop();
          process.stdout.write(json + '\n');
        }
      } catch (err) {
        spinner.fail(kleur.red(err.message));
        process.exitCode = 1;
      }
    })
    // New: Deploy a Notion App from YAML blueprint
    .command('deploy <blueprintPath> <targetId>', 'Deploy a Notion App from YAML blueprint', (y) => {
      return y
        .positional('blueprintPath', { describe: 'Path to YAML blueprint file', type: 'string' })
        .positional('targetId', { describe: 'Target page ID where resources will be created', type: 'string' })
        .option('baseUrl', { type: 'string', describe: 'Override backend base URL' })
        .option('appSecret', { type: 'string', describe: 'HMAC secret for signing action URLs (optional)' });
    }, async (args) => {
      const spinner = ora('Deploying Notion App...').start();
      try {
        assertIdLike(args.targetId, 'targetId');
        const res = await deployBlueprint(args.blueprintPath, args.targetId, { baseUrl: args.baseUrl, appSecret: args.appSecret });
        spinner.succeed(kleur.green(`Deployment complete. Info page: ${res.info}`));
        if (!args.appSecret) {
          console.log(kleur.yellow('Note: appSecret not provided; URL buttons were not signed/attached. Re-run a maintenance step once backend is configured.'));
        }
      } catch (err) {
        spinner.fail(kleur.red(err.message));
        process.exitCode = 1;
      }
    })
    .demandCommand(1)
    .help()
    .argv;
}

main().catch((e) => {
  console.error(kleur.red(e.stack || e.message));
  process.exit(1);
});

// Build Notion DB properties from simplified blueprint schema
function buildDbProperties(schema = {}, aliasToId = {}) {
  const out = {};
  for (const [name, def] of Object.entries(schema)) {
    const t = def?.type;
    if (!t) continue;
    switch (t) {
      case 'title':
        out[name] = { title: {} };
        break;
      case 'status': {
        const options = def?.status?.options || [];
        out[name] = { status: { options: options.map(o => ({ name: o.name || o, color: o.color || 'default' })) } };
        break;
      }
      case 'multi_select': {
        const options = def?.multi_select?.options || [];
        out[name] = { multi_select: { options: options.map(o => ({ name: o.name || o, color: o.color || 'default' })) } };
        break;
      }
      case 'select': {
        const options = def?.select?.options || [];
        out[name] = { select: { options: options.map(o => ({ name: o.name || o, color: o.color || 'default' })) } };
        break;
      }
      case 'checkbox':
        out[name] = { checkbox: {} };
        break;
      case 'number':
        out[name] = { number: {} };
        break;
      case 'date':
        out[name] = { date: {} };
        break;
      case 'rich_text':
        out[name] = { rich_text: {} };
        break;
      case 'url':
        out[name] = { url: {} };
        break;
      case 'relation': {
        const alias = def?.relation?.database;
        const dbId = aliasToId[alias];
        if (!dbId) {
          // Fallback: will set later, but create a placeholder the API rejects; so skip for now
          continue;
        }
        out[name] = { relation: { database_id: dbId, type: 'single_property', single_property: {} } };
        break;
      }
      default:
        // ignore unsupported types for now
        break;
    }
  }
  return out;
}

function hmacSign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function buildActionUrl(baseUrl, action, params, secret) {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  const ordered = ['taskId', 'action', 'ts', 'nonce', 'tasksDbId', 'calendarDbId']
    .map(k => params[k] || (k === 'action' ? action : ''));
  const sig = secret ? hmacSign(secret, ordered.join('|')) : undefined;
  const sp = new URLSearchParams({ ...params, action, ts, nonce });
  if (sig) sp.set('sig', sig);
  const url = `${baseUrl.replace(/\/$/, '')}/a/${action}?${sp.toString()}`;
  return url;
}

async function injectActionLinksOnTask(taskPageId, links) {
  // Append a paragraph with Start | Pause | Stop links
  const rich = [];
  const entries = [ ['Start', links.start], ['Pause', links.pause], ['Stop', links.stop] ];
  entries.forEach((pair, idx) => {
    const [label, href] = pair;
    rich.push({ type: 'text', text: { content: label, link: { url: href } } });
    if (idx < entries.length - 1) rich.push({ type: 'text', text: { content: '  |  ' } });
  });
  await withRetry(() => ensureClient().blocks.children.append({
    block_id: taskPageId,
    children: [{ type: 'paragraph', paragraph: { rich_text: rich } }],
  }));
}

async function setTaskUrlProperties(taskId, urls) {
  await withRetry(() => ensureClient().pages.update({
    page_id: taskId,
    properties: {
      'Start URL': { url: urls.start },
      'Pause URL': { url: urls.pause },
      'Stop URL': { url: urls.stop },
    },
  }));
}

async function createRelationPlaceholders(databases, parentPageId) {
  // First pass create DBs without relation properties; second pass add relations
  const created = {};
  // Create in order
  for (const db of databases) {
    const propsNoRelation = buildDbProperties(
      Object.fromEntries(Object.entries(db.properties || {}).filter(([, v]) => v.type !== 'relation'))
    );
    const createdDb = await withRetry(() => ensureClient().databases.create({
      parent: { page_id: parentPageId },
      title: [{ type: 'text', text: { content: db.title } }],
      properties: propsNoRelation,
    }));
    created[db.alias] = createdDb.id;
  }
  // Second pass: patch in relation properties where needed
  for (const db of databases) {
    const relationProps = Object.fromEntries(
      Object.entries(db.properties || {}).filter(([, v]) => v.type === 'relation')
    );
    if (Object.keys(relationProps).length) {
      const schema = buildDbProperties(db.properties, created);
      await withRetry(() => ensureClient().databases.update({
        database_id: created[db.alias],
        properties: schema,
      }));
    }
  }
  return created;
}

async function createSeeds(seeds = {}, aliasToId = {}) {
  // Support simple seeds for databases by alias, e.g., tasks: [{ Name: "Sample Task" }]
  const created = { pages: {}, rows: {} };
  for (const [alias, rows] of Object.entries(seeds || {})) {
    const databaseId = aliasToId[alias];
    if (!databaseId) continue;
    const titleName = await getDatabaseTitlePropName(databaseId);
    for (const row of rows) {
      const titleVal = row[titleName] || row.Name || 'Untitled';
      const properties = Object.fromEntries(
        Object.entries(row).map(([k, v]) => {
          if (k === titleName || k === 'Name') return [titleName, { title: [{ type: 'text', text: { content: String(titleVal) } }] }];
          if (typeof v === 'number') return [k, { number: v }];
          if (typeof v === 'string') return [k, { rich_text: [{ type: 'text', text: { content: v } }] }];
          return [k, v];
        })
      );
      const page = await withRetry(() => ensureClient().pages.create({ parent: { database_id: databaseId }, properties }));
      if (!created.rows[alias]) created.rows[alias] = [];
      created.rows[alias].push(page);
    }
  }
  return created;
}

async function deployBlueprint(blueprintPath, targetPageId, opts = {}) {
  if (!yaml) throw new Error('YAML support not installed. Please ensure js-yaml is in dependencies.');
  const full = path.resolve(process.cwd(), blueprintPath);
  if (!fs.existsSync(full)) throw new Error('Blueprint file not found');
  const doc = yaml.load(fs.readFileSync(full, 'utf8')) || {};
  const backend = doc.backend || {};
  const baseUrl = opts.baseUrl || backend.baseUrl;
  const appSecret = opts.appSecret; // do not store in Notion

  const databases = Array.isArray(doc.resources?.databases) ? doc.resources.databases : [];
  const pages = Array.isArray(doc.resources?.pages) ? doc.resources.pages : [];

  // Create DBs (two-pass to attach relations)
  const aliasToId = await createRelationPlaceholders(databases, targetPageId);

  // Create pages under target
  const createdPages = {};
  for (const pg of pages) {
    const created = await withRetry(() => ensureClient().pages.create({
      parent: { page_id: targetPageId },
      properties: { title: { title: [{ type: 'text', text: { content: pg.title || 'Untitled' } }] } },
      icon: pg.icon,
      cover: pg.cover,
    }));
    createdPages[pg.alias || created.id] = created.id;
    if (Array.isArray(pg.children) && pg.children.length) {
      for (let i = 0; i < pg.children.length; i += 50) {
        await withRetry(() => ensureClient().blocks.children.append({ block_id: created.id, children: pg.children.slice(i, i + 50) }));
      }
    }
  }

  // Seeds
  const seeds = doc.install?.seeds || {};
  const createdSeeds = await createSeeds(seeds, aliasToId);

  // Triggers for tasks
  const tasksAlias = doc.workflows?.find?.(() => false) ? null : (databases.find(d => d.alias === 'tasks') ? 'tasks' : null);
  if (tasksAlias && baseUrl && appSecret) {
    const tasksDbId = aliasToId[tasksAlias];
    const calendarDbId = aliasToId['calendar'];
    // Query all tasks (including seeds) and attach links
    let cursor;
    do {
      const resp = await withRetry(() => ensureClient().databases.query({ database_id: tasksDbId, start_cursor: cursor }));
      for (const row of resp.results) {
        const urls = {
          start: buildActionUrl(baseUrl, 'start', { taskId: row.id, tasksDbId, calendarDbId }, appSecret),
          pause: buildActionUrl(baseUrl, 'pause', { taskId: row.id, tasksDbId, calendarDbId }, appSecret),
          stop: buildActionUrl(baseUrl, 'stop', { taskId: row.id, tasksDbId, calendarDbId }, appSecret),
        };
        await setTaskUrlProperties(row.id, urls);
        await injectActionLinksOnTask(row.id, urls);
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
  }

  // Create minimal install info page (without secrets)
  const info = await withRetry(() => ensureClient().pages.create({
    parent: { page_id: targetPageId },
    properties: { title: { title: [{ type: 'text', text: { content: (doc.metadata?.name || 'App') + ' - Installed' } }] } },
  }));
  const summary = `Installed app: ${doc.metadata?.name || 'App'}\nTasks DB: ${aliasToId.tasks || '-'}\nCalendar DB: ${aliasToId.calendar || '-'}\nBase URL: ${baseUrl || '-'}\n`;
  await withRetry(() => ensureClient().blocks.children.append({ block_id: info.id, children: [ { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: summary } }] } } ] }));

  return { aliasToId, pages: createdPages, info: info.id };
}