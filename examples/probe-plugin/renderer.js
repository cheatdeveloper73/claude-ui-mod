/* claude-ui-mod :: probe (renderer) — EXAMPLE, not loaded by default
 *
 * Gathers evidence from the isolated world and hands it to main, which writes
 * it to .probe/report.json.
 *
 * Session resolution is async and finishes AFTER plugin init, so poll for
 * cuimod.sessionId rather than reading it once at the top.
 */
'use strict';

let tries = 0;
const stop = ctx.every(500, async () => {
    if (!cuimod.sessionId && ++tries < 20) return;
    stop && clearInterval(stop);

    const report = {
        sessionId: cuimod.sessionId,
        url: location.pathname,
        tasks: (await cuimod.getTasks()).map((t) => ({ id: t.id, status: t.status, subject: t.subject })),
        host: await cuimod.rpc('host.info'),
        // Last few channels the app itself used — how you discover an API.
        recentChannels: cuimod.tap.slice(-10).map((e) => e.channel),
        errors: cuimod.errors,
    };

    try { await cuimod.rpc('probe.report', report); } catch (e) { cuimod.log('probe report failed', e); }
});
