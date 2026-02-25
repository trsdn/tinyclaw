import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-config-test-'));
  // Point TINYCLAW_HOME to our temp dir before importing config
  process.env.TINYCLAW_HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.TINYCLAW_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getSettings ───────────────────────────────────────────────────────────────

describe('getSettings', () => {
  it('reads and caches settings from file', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ workspace: { name: 'test' } }));

    const { getSettings } = await import('../../src/lib/config');
    const s1 = getSettings();
    expect(s1.workspace?.name).toBe('test');

    // Second call should return cached value (even if file changes)
    fs.writeFileSync(settingsPath, JSON.stringify({ workspace: { name: 'changed' } }));
    const s2 = getSettings();
    expect(s2.workspace?.name).toBe('test'); // still cached
  });

  it('re-reads settings after TTL expires', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ workspace: { name: 'v1' } }));

    const { getSettings, invalidateSettingsCache } = await import('../../src/lib/config');
    const s1 = getSettings();
    expect(s1.workspace?.name).toBe('v1');

    // Invalidate cache to simulate TTL expiry
    invalidateSettingsCache();

    fs.writeFileSync(settingsPath, JSON.stringify({ workspace: { name: 'v2' } }));
    const s2 = getSettings();
    expect(s2.workspace?.name).toBe('v2');
  });

  it('returns empty object when settings file is missing', async () => {
    const { getSettings } = await import('../../src/lib/config');
    const settings = getSettings();
    expect(settings).toEqual({});
  });

  it('auto-repairs malformed JSON', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    // Write malformed JSON (trailing comma)
    fs.writeFileSync(settingsPath, '{ "workspace": { "name": "repaired", } }');

    const { getSettings } = await import('../../src/lib/config');
    const settings = getSettings();
    expect(settings.workspace?.name).toBe('repaired');

    // A backup should have been created
    expect(fs.existsSync(settingsPath + '.bak')).toBe(true);
  });
});

// ── getAgents ─────────────────────────────────────────────────────────────────

describe('getAgents', () => {
  it('returns configured agents when present', async () => {
    const { getAgents } = await import('../../src/lib/config');
    const settings = {
      agents: {
        coder: { name: 'Coder', provider: 'anthropic', model: 'sonnet', working_directory: '/tmp/coder' },
      },
    };
    const result = getAgents(settings);
    expect(result).toHaveProperty('coder');
    expect(result.coder.name).toBe('Coder');
  });

  it('falls back to default agent when no agents are configured', async () => {
    const { getAgents } = await import('../../src/lib/config');
    const settings = {
      models: { provider: 'anthropic', anthropic: { model: 'opus' } },
    };
    const result = getAgents(settings);
    expect(result).toHaveProperty('default');
    expect(result.default.provider).toBe('anthropic');
    expect(result.default.model).toBe('opus');
  });
});

// ── resolveClaudeModel ────────────────────────────────────────────────────────

describe('resolveClaudeModel', () => {
  it('maps shorthand "sonnet" to full model ID', async () => {
    const { resolveClaudeModel } = await import('../../src/lib/config');
    expect(resolveClaudeModel('sonnet')).toBe('claude-sonnet-4-5');
  });

  it('maps shorthand "opus" to full model ID', async () => {
    const { resolveClaudeModel } = await import('../../src/lib/config');
    expect(resolveClaudeModel('opus')).toBe('claude-opus-4-6');
  });

  it('passes through unknown model strings unchanged', async () => {
    const { resolveClaudeModel } = await import('../../src/lib/config');
    expect(resolveClaudeModel('custom-model-v1')).toBe('custom-model-v1');
  });

  it('returns empty string for empty input', async () => {
    const { resolveClaudeModel } = await import('../../src/lib/config');
    expect(resolveClaudeModel('')).toBe('');
  });
});
