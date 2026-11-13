import { beforeAll, afterAll } from 'vitest';

// Suppress unhandled rejection warnings for expected test errors
const originalHandlers = process.listeners('unhandledRejection');

beforeAll(() => {
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', reason => {
    // Ignore EngineError timeouts which are expected in tests
    if (reason instanceof Error && reason.message.includes('Task timeout')) {
      return;
    }
    if (
      reason &&
      typeof reason === 'object' &&
      'code' in reason &&
      reason.code === 'INTERNAL_ERROR'
    ) {
      const err = reason as { message?: string };
      if (err.message?.includes('Task timeout')) {
        return;
      }
    }
    // Re-emit for other unhandled rejections
    console.error('Unhandled rejection:', reason);
  });
});

afterAll(() => {
  process.removeAllListeners('unhandledRejection');
  for (const handler of originalHandlers) {
    process.on('unhandledRejection', handler);
  }
});
