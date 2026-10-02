'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonlIndex, findSessionFile, UUID } = require('./jsonl-index');

module.exports = function (ctx) {
    const pageSource = fs.readFileSync(path.join(ctx.dir, 'page.js'), 'utf8');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    const statusDir = path.resolve(ctx.dir, '../../../.probe/message-time');
    const generation = ctx.boot.generation;
    const statusFile = path.join(statusDir, 'status-' + generation + '.json');
    const sessions = new Map();
    const views = new Map();
    let lastStatus = '';

    function writeStatus() {
        const current = JSON.stringify({ generation, views: [...views.values()] });
        if (current === lastStatus) return;
        try {
            fs.mkdirSync(statusDir, { recursive: true });
            fs.writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(current), observedAt: new Date().toISOString() }, null, 2));
            lastStatus = current;
        } catch (_) { /* Diagnostics must not change the transcript path. */ }
    }

    function setView(event, sessionId, rows) {
        if (!event?.sender || event.sender.isDestroyed()) return;
        const url = event.sender.getURL();
        const previous = views.get(event.sender.id);
        if (previous?.url === url && previous.sessionId === sessionId
            && JSON.stringify(previous.rows) === JSON.stringify(rows)) return;
        const at = new Date().toISOString();
        const changed = rows.filter((row) => row.jsonlIso && row.nativeIso !== row.jsonlIso
            && !(previous?.sessionId === sessionId && previous.url === url && previous.rows.some((old) => old.uuid === row.uuid
                && old.nativeIso === row.nativeIso && old.datetime === row.datetime
                && old.jsonlIso === row.jsonlIso && old.applied === row.applied)));
        const corrections = (previous?.corrections || []).concat(changed.map((row) => ({ at, ...row }))).slice(-80);
        views.delete(event.sender.id);
        views.set(event.sender.id, { webContentsId: event.sender.id, url,
            sessionId, rows, corrections });
        while (views.size > 16) views.delete(views.keys().next().value);
        writeStatus();
    }

    async function indexFor(sessionId) {
        const now = Date.now();
        for (const [id, item] of sessions) {
            if (id !== sessionId && now - item.used > 5 * 60 * 1000) sessions.delete(id);
        }
        let item = sessions.get(sessionId);
        if (!item) {
            const file = await findSessionFile(projectsRoot, sessionId);
            if (!file) return null;
            item = { index: new JsonlIndex(file), used: now, pending: Promise.resolve() };
            sessions.set(sessionId, item);
        }
        item.used = now;
        const work = item.pending.then(() => item.index.update());
        item.pending = work.catch(() => {});
        return work;
    }

    ctx.method('resolve', async (params, event) => {
        const sessionId = params?.sessionId;
        if (!UUID.test(sessionId || '') || !event?.sender || event.sender.isDestroyed()) return [];
        let rows;
        try {
            rows = await event.sender.executeJavaScript(pageSource, false);
            if (!Array.isArray(rows) || event.sender.isDestroyed()) return [];
        } catch (_) { return []; }
        let index;
        try { index = await indexFor(sessionId); }
        catch (_) { return []; }
        const result = [];
        const statusRows = [];
        for (const row of rows) {
            if (!UUID.test(row?.uuid || '')) continue;
            const iso = index?.get(row.uuid) || null;
            statusRows.push({ uuid: row.uuid, nativeIso: row.nativeIso || null,
                jsonlIso: iso, datetime: row.nativeIso || null, applied: false });
            if (iso) result.push({ uuid: row.uuid, iso });
        }
        setView(event, sessionId, statusRows);
        return result;
    });

    ctx.method('report', (params, event) => {
        if (!event?.sender || event.sender.isDestroyed()) return false;
        const sessionId = UUID.test(params?.sessionId || '') ? params.sessionId : null;
        const rows = Array.isArray(params?.rows) ? params.rows
            .filter((row) => UUID.test(row?.uuid || ''))
            .map((row) => ({
                uuid: row.uuid,
                nativeIso: row.nativeIso || null,
                jsonlIso: row.jsonlIso || null,
                datetime: row.datetime || null,
                applied: row.applied === true,
                reactTextTicks: Number.isInteger(row.reactTextTicks) ? row.reactTextTicks : 0,
                lastReactTextAt: row.lastReactTextAt || null,
            })) : [];
        setView(event, sessionId, rows);
        return true;
    });
};
