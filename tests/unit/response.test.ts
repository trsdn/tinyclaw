import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-response-test-'));
  // Create the files directory that handleLongResponse writes to
  const filesDir = path.join(tmpDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  process.env.TINYCLAW_HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.TINYCLAW_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── handleLongResponse ────────────────────────────────────────────────────────

describe('handleLongResponse', () => {
  it('returns the response unchanged when under threshold', async () => {
    const { handleLongResponse, LONG_RESPONSE_THRESHOLD } = await import('../../src/lib/response');
    const shortMsg = 'a'.repeat(LONG_RESPONSE_THRESHOLD - 1);

    const result = handleLongResponse(shortMsg, []);
    expect(result.message).toBe(shortMsg);
    expect(result.files).toEqual([]);
  });

  it('returns the response unchanged when exactly at threshold', async () => {
    const { handleLongResponse, LONG_RESPONSE_THRESHOLD } = await import('../../src/lib/response');
    const exactMsg = 'a'.repeat(LONG_RESPONSE_THRESHOLD);

    const result = handleLongResponse(exactMsg, []);
    expect(result.message).toBe(exactMsg);
    expect(result.files).toEqual([]);
  });

  it('truncates and saves to file when over threshold', async () => {
    const { handleLongResponse, LONG_RESPONSE_THRESHOLD } = await import('../../src/lib/response');
    const longMsg = 'a'.repeat(LONG_RESPONSE_THRESHOLD + 100);

    const result = handleLongResponse(longMsg, ['/existing/file.txt']);
    expect(result.message.length).toBeLessThan(longMsg.length);
    expect(result.message).toContain('_(Full response attached as file)_');
    expect(result.files.length).toBe(2); // existing + new
    expect(result.files[0]).toBe('/existing/file.txt');
    // The saved file should exist on disk
    expect(fs.existsSync(result.files[1])).toBe(true);
  });

  it('preserves existing files in the returned array', async () => {
    const { handleLongResponse, LONG_RESPONSE_THRESHOLD } = await import('../../src/lib/response');
    const longMsg = 'x'.repeat(LONG_RESPONSE_THRESHOLD + 1);
    const existing = ['/a.txt', '/b.txt'];

    const result = handleLongResponse(longMsg, existing);
    expect(result.files[0]).toBe('/a.txt');
    expect(result.files[1]).toBe('/b.txt');
    expect(result.files.length).toBe(3);
  });
});

// ── collectFiles ──────────────────────────────────────────────────────────────

describe('collectFiles', () => {
  it('adds existing files from [send_file: ...] tags', async () => {
    const { collectFiles } = await import('../../src/lib/response');

    // Create a temp file to reference
    const testFile = path.join(tmpDir, 'test-attachment.txt');
    fs.writeFileSync(testFile, 'content');

    const fileSet = new Set<string>();
    collectFiles(`Here is the file: [send_file: ${testFile}]`, fileSet);

    expect(fileSet.has(testFile)).toBe(true);
  });

  it('skips non-existent file paths', async () => {
    const { collectFiles } = await import('../../src/lib/response');

    const fileSet = new Set<string>();
    collectFiles('[send_file: /nonexistent/path/file.txt]', fileSet);

    expect(fileSet.size).toBe(0);
  });

  it('collects multiple files from a single response', async () => {
    const { collectFiles } = await import('../../src/lib/response');

    const file1 = path.join(tmpDir, 'file1.txt');
    const file2 = path.join(tmpDir, 'file2.txt');
    fs.writeFileSync(file1, 'a');
    fs.writeFileSync(file2, 'b');

    const fileSet = new Set<string>();
    collectFiles(
      `[send_file: ${file1}] some text [send_file: ${file2}]`,
      fileSet
    );

    expect(fileSet.size).toBe(2);
    expect(fileSet.has(file1)).toBe(true);
    expect(fileSet.has(file2)).toBe(true);
  });
});
