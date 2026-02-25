import http from 'http';
import { onEvent } from '../lib/logging';

const sseClients = new Set<http.ServerResponse>();

/** Broadcast an SSE event to every connected client. */
export function broadcastSSE(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(message); } catch { sseClients.delete(client); }
    }
}

export function addSSEClient(res: http.ServerResponse): void {
    sseClients.add(res);
}

export function removeSSEClient(res: http.ServerResponse): void {
    sseClients.delete(res);
}

onEvent((type, data) => {
    const payload: Record<string, unknown> = { type, timestamp: Date.now(), ...data };
    if ((type === 'response_ready' || type === 'chain_step_done') && typeof payload.responseText === 'string') {
        const text = payload.responseText as string;
        if (text.length > 200) {
            payload.responseText = text.substring(0, 200) + '...';
        }
    }
    broadcastSSE(type, payload);
});
