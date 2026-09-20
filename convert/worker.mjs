import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('worker.mjs must run inside a worker thread');

parentPort.on('message', async ({ task, index, item }) => {
  try {
    let result;
    if (task === 'readExport') {
      result = await (await import('./tana_tine/model.mjs')).readExport(item);
    } else if (task === 'serializePage') {
      result = (await import('./tana_tine/model.mjs')).serializePage(item);
    } else if (task === 'discoverExport') {
      result = await (await import('./asset-cache.mjs')).discoverExport(item);
    } else if (task === 'rewriteProperties') {
      result = await (await import('./property-rewrite.mjs')).rewriteDocument(item);
    } else if (task === 'rewriteDecisionPage') {
      result = await (await import('./import-decisions.mjs')).rewriteDecisionPage(item);
    } else {
      throw new Error(`Unknown worker task: ${task}`);
    }
    parentPort.postMessage({ index, result });
  } catch (error) {
    parentPort.postMessage({ index, error: { name: error.name, message: error.message, stack: error.stack } });
  }
});
