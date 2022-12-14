import util from 'util';
import chalk from 'chalk';
import ngrok from 'ngrok';
import { createServer } from 'http';
import { Server } from 'http';
import Client from './client';
import fetch from 'node-fetch';
import { IncomingMessage } from 'http';
import getScope from './get-scope';

export const ALL_EVENTS = [
  'deployment.created',
  'deployment.error',
  'deployment.succeeded',
  'deployment.canceled',
  'domain.created',
  'project.created',
  'project.removed',
];

interface WebhookServerOptions {
  logWebhookPayloads: boolean;
  forwardingRules: {
    events: string[];
    url: string;
  }[];
}

export class WebhookServer {
  client: Client;
  options: WebhookServerOptions;

  webhook?: { id: string };
  tunnelUrl?: string;
  server?: Server;

  constructor(client: Client, options: WebhookServerOptions) {
    this.client = client;
    this.options = options;
  }

  async start() {
    this.server = startWebhookServer(this.client, this.options);
    this.tunnelUrl = await startTunnel(
      this.client,
      (this.server.address() as { port: number }).port
    );
    this.webhook = await createWebhook(this.client, this.tunnelUrl);

    const { contextName } = await getScope(this.client);
    this.client.output.log(
      `Listening for webhooks on ${chalk.bold(contextName)}`
    );

    if (this.options.forwardingRules.length) {
      this.client.output.log(`Forwarding webhooks to:`);

      this.options.forwardingRules.forEach(({ events, url }) => {
        this.client.output.log(
          ` * ${chalk.bold(url)} [${formatEvents(events)}]`
        );
      });
    }
  }

  async stop() {
    this.client.output.log('Stopping the webhook server');

    if (this.tunnelUrl) {
      try {
        await closeTunnel(this.client, this.tunnelUrl);
        this.tunnelUrl = undefined;
      } catch (err) {
        this.client.output.error(
          `Unable to close tunnel at '${this.tunnelUrl}'`
        );
        this.client.output.debug(`Error: ${(err as Error).stack}`);
      }
    }

    if (this.webhook) {
      try {
        await destroyWebhook(this.client, this.webhook.id);
        this.webhook = undefined;
      } catch (err) {
        this.client.output.error(
          `Unable to cleanup webhook '${this.webhook?.id}'`
        );
        this.client.output.debug(`Error: ${(err as Error).stack}`);
      }
    }

    if (this.server) {
      try {
        await stopWebhookServer(this.client, this.server);
        this.server = undefined;
      } catch (err) {
        this.client.output.error(`Unable to stop webhook server`);
        this.client.output.debug(`Error: ${(err as Error).stack}`);
      }
    }
  }
}

function startWebhookServer(
  client: Client,
  { logWebhookPayloads, forwardingRules }: WebhookServerOptions
): Server {
  const server = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);

      if (logWebhookPayloads) {
        client.output.print(`>>> ${chalk.bold(payload.type)}`);
        client.output.print(
          `\n\n${util.inspect(payload, { depth: Infinity, colors: true })}\n\n`
        );
      }

      if (forwardingRules.length) {
        await Promise.all(
          forwardingRules.map(async ({ events, url }) => {
            if (!events.includes(payload.type)) {
              return;
            }

            client.output.debug(`POST ${url}`);

            await fetch(url, {
              method: 'POST',
              headers: req.headers as Record<string, string>,
              body: JSON.stringify(body),
            });

            client.output.log(
              `Webhook ${chalk.bold(
                payload.type
              )} forwarded to ${url} [${events.join(', ')}]`
            );
          })
        );
      }

      res.statusCode = 200;
    } catch (err) {
      client.output.error((err as Error).message);

      res.statusCode = 500;
    } finally {
      res.end();
    }
  }).listen(0);

  client.output.debug(
    `webhook server started on ${JSON.stringify(server.address())}`
  );

  return server;
}

async function stopWebhookServer(client: Client, server: Server) {
  return new Promise((resolve, reject) => {
    const serverAddress = server.address();

    server.close(err => {
      if (err) {
        reject(err);
      }

      client.output.debug(
        `webhook server stopped on ${JSON.stringify(serverAddress)}`
      );

      resolve(undefined);
    });
  });
}

async function startTunnel(client: Client, port: number): Promise<string> {
  const url = await ngrok.connect(port);

  client.output.debug(`Tunnel created (url = ${url}, port = ${port})`);

  return url;
}

async function closeTunnel(client: Client, url: string) {
  await ngrok.kill();

  client.output.debug(`Tunnel destroyed (url = ${url})`);
}

async function createWebhook(
  client: Client,
  url: string
): Promise<{ id: string }> {
  const webhook = await client.fetch<{ id: string }>('/v1/webhooks', {
    method: 'POST',
    body: {
      url,
      events: ALL_EVENTS,
    },
  });

  client.output.debug(`Vercel webhook created (webhook.id = ${webhook.id})`);

  return webhook;
}

async function destroyWebhook(client: Client, webhookId: string) {
  await client.fetch(`/v1/webhooks/${webhookId}`, {
    method: 'DELETE',
  });

  client.output.debug(`Vercel webhook deleted (webhook.id = ${webhookId})`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function formatEvents(events: string[]) {
  if (ALL_EVENTS.every(event => events.includes(event))) {
    return 'All Events';
  }

  return events.join(',');
}
