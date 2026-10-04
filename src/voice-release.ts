/** Hang-up never asks the text agent to answer the spoken conversation again. */
export async function releaseVoiceChat(
  request: (method: string, params: { threadId: string }) => Promise<unknown>,
  threadId: string,
  report: (message: string) => void = console.error,
): Promise<boolean> {
  try {
    await request('thread/realtime/stop', { threadId });
  } catch (error) {
    report(`Could not stop voice for ${threadId}: ${String(error)}`);
  }
  try {
    await request('thread/unsubscribe', { threadId });
    return true;
  } catch (error) {
    report(`Could not release voice chat ${threadId}: ${String(error)}`);
    return false;
  }
}
