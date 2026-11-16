// Boots the forge on an ephemeral port, tells the env where it is, and leaves
// once the env says the trial is finished. Health checks are served as soon
// as the socket is listening, which is before registration.
// Registration is one POST of the bound port; a 409 means the env already has it.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(app: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    app.once('error', onError);
    app.listen(0, '0.0.0.0', () => {
      app.off('error', onError);
      const address = app.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('the forge did not receive a port'));
    });
  });
}

async function register(port: number): Promise<void> {
  const response = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (response.status === 200 || response.status === 409) return;
  throw new Error(`register answered HTTP ${response.status}`);
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    const response = await fetch(`${envUrl}/done`);
    if (response.ok) {
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const port = await listen(app);
  if (!envUrl) {
    process.stdout.write(`forge listening on ${port}\n`);
    return;
  }
  await register(port);
  await waitUntilDone();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  process.exit(0);
}

main().catch(() => {
  process.exit(1);
});
