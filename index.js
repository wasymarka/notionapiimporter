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

let notion = null;
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
    .demandCommand(1)
    .help()
    .argv;
}

main().catch((e) => {
  console.error(kleur.red(e.stack || e.message));
  process.exit(1);
});