import fs from 'fs';
import { Hono } from 'hono';
import { LOG_FILE } from '../../lib/config';

const TAIL_BYTES = 64 * 1024; // 64 KB

const app = new Hono();

// GET /api/logs
app.get('/api/logs', (c) => {
    const limit = parseInt(c.req.query('limit') || '100', 10);
    try {
        const stat = fs.statSync(LOG_FILE);
        const readSize = Math.min(stat.size, TAIL_BYTES);
        const offset = stat.size - readSize;
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(LOG_FILE, 'r');
        fs.readSync(fd, buf, 0, readSize, offset);
        fs.closeSync(fd);
        const chunk = buf.toString('utf8');
        // If we started mid-file, drop the first (potentially partial) line
        const lines = chunk.split('\n');
        if (offset > 0) lines.shift();
        // Remove trailing empty element from split
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        return c.json({ lines: lines.slice(-limit) });
    } catch {
        return c.json({ lines: [] });
    }
});

export default app;
