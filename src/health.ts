import { classifyVoiceFailure } from './failures';

/** Only operational facts belong here; never transcripts, settings, or raw errors. */
export class ListenerHealth {
  #status: 'starting' | 'ready' | 'failed' = 'starting';
  #lastError: ReturnType<typeof classifyVoiceFailure> | null = null;

  ready(): void { this.#status = 'ready'; }
  failed(message: string): void {
    this.#status = 'failed';
    this.noteCallFailure(message);
  }
  noteCallFailure(message: string): void { this.#lastError = classifyVoiceFailure(message); }
  clearCallFailure(): void { this.#lastError = null; }

  response(request: Request, local: boolean, connected: boolean, activeCalls: number): Response {
    if (!local) return new Response('Forbidden', { status: 403 });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    return Response.json({
      service: 'esp32-voice-mode',
      schemaVersion: 1,
      companion: { status: this.#status },
      device: { connected },
      calls: { active: activeCalls },
      lastError: this.#lastError,
    }, { status: this.#status === 'ready' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
