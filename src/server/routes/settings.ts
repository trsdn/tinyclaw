import fs from 'fs';
import { Hono } from 'hono';
import { Settings } from '../../lib/types';
import { SETTINGS_FILE, getSettings, invalidateSettingsCache } from '../../lib/config';
import { log } from '../../lib/logging';

/** Simple recursive merge for plain objects. Arrays and non-plain values are overwritten. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const tVal = target[key];
        const sVal = source[key];
        if (
            tVal && sVal &&
            typeof tVal === 'object' && typeof sVal === 'object' &&
            !Array.isArray(tVal) && !Array.isArray(sVal)
        ) {
            result[key] = deepMerge(tVal as Record<string, unknown>, sVal as Record<string, unknown>);
        } else {
            result[key] = sVal;
        }
    }
    return result;
}

/** Read, mutate, and persist settings.json atomically. */
export function mutateSettings(fn: (settings: Settings) => void): Settings {
    invalidateSettingsCache();
    const settings = getSettings();
    fn(settings);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
    invalidateSettingsCache();
    return settings;
}

const app = new Hono();

// GET /api/settings
app.get('/api/settings', (c) => {
    const settings = getSettings();
    const safe = JSON.parse(JSON.stringify(settings));
    if (safe.api?.api_key) safe.api.api_key = '***';
    return c.json(safe);
});

// PUT /api/settings
app.put('/api/settings', async (c) => {
    const body = await c.req.json();
    if (body?.api?.api_key !== undefined || body?.api?.bind_host !== undefined) {
        return c.json({ error: 'api.api_key and api.bind_host cannot be set via this endpoint' }, 400);
    }
    invalidateSettingsCache();
    const current = getSettings();
    const merged = deepMerge(current as Record<string, unknown>, body as Record<string, unknown>) as Settings;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n');
    invalidateSettingsCache();
    log('INFO', '[API] Settings updated');
    return c.json({ ok: true, settings: merged });
});

export default app;
