import util from 'util';
import chalk from 'chalk';
import getArgs from '../util/get-args';
import ngrok from 'ngrok';
import logo from '../util/output/logo';
import { handleError } from '../util/error';
import { getPkgName } from '../util/pkg-name';
import Client from '../util/client';
import { Server, createServer, IncomingMessage } from 'http';
import getScope from '../util/get-scope';
import fetch from 'node-fetch';

const EVENTS = [
  'deployment.created',
  'deployment.error',
  'deployment.succeeded',
  'project.created',
  'project.removed',
];

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} ${getPkgName()} webhooks`)} <url>

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`vercel.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.vercel`'} directory
    -d, --debug                    Debug mode [off]
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline(
    'TOKEN'
  )}        Login token
    --forward-to ${chalk.bold.underline(
      'URL'
    )}               The URL to forward the webhooks to e.g. http://localhost:3000/api/webhook
    --no-log                       Don't output the webhook payloads
  `);
};

export default async function main(client: Client) {
  let argv;

  try {
    argv = getArgs(client.argv.slice(2), {
      '--no-log': Boolean,
      '--forward-to': String,
    });
  } catch (err) {
    handleError(err);
    return 1;
  }

  if (argv['--help']) {
    help();
    return 2;
  }

  await listen(client, {
    logWebhookPayloads: !argv['--no-log'],
    forwardingUrl: argv['--forward-to'],
  });

  return 0;
}

function listen(
  client: Client,
  {
    logWebhookPayloads,
    forwardingUrl,
  }: {
    logWebhookPayloads: boolean;
    forwardingUrl: string | undefined;
  }
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const port = 8999;
    const { log } = client.output;

    let tunnelUrl: string | undefined;
    let server: Server | undefined;
    let webhook: { id: string } | undefined;

    const stop = async () => {
      client.output.log('Stopping the webhook server');

      if (tunnelUrl) {
        try {
          await closeTunnel(client, tunnelUrl);
          tunnelUrl = undefined;
        } catch (err) {
          client.output.error(`Unable to close tunnel at '${tunnelUrl}'`);
          client.output.debug(`Error: ${(err as Error).stack}`);
        }
      }

      if (webhook) {
        try {
          await destroyWebhook(client, webhook.id);
          webhook = undefined;
        } catch (err) {
          client.output.error(`Unable to cleanup webhook '${webhook?.id}'`);
          client.output.debug(`Error: ${(err as Error).stack}`);
        }
      }

      if (server) {
        try {
          await stopWebhookServer(client, server);
          server = undefined;
        } catch (err) {
          client.output.error(`Unable to stop webhook server`);
          client.output.debug(`Error: ${(err as Error).stack}`);
        }
      }
    };

    try {
      tunnelUrl = await startTunnel(client, port);
      webhook = await createWebhook(client, tunnelUrl);
      server = startWebhookServer(client, {
        port,
        logWebhookPayloads,
        forwardingUrl,
      });

      const exitGracefully = async () => {
        try {
          await stop();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      process.once('SIGTERM', exitGracefully);
      process.once('SIGINT', exitGracefully);
      process.once('SIGUSR1', exitGracefully);
      process.once('SIGUSR2', exitGracefully);

      const { contextName } = await getScope(client);
      log(`Listening for webhooks on ${chalk.bold(contextName)}`);

      if (forwardingUrl) {
        log(`Forwarding webhooks to ${chalk.bold(forwardingUrl)}`);
      }
    } catch (err) {
      await stop()
        .then(() => reject(err))
        .catch(reject);
    }
  });
}

function startWebhookServer(
  client: Client,
  {
    logWebhookPayloads,
    forwardingUrl,
    port,
  }: {
    logWebhookPayloads: boolean;
    forwardingUrl: string | undefined;
    port: number;
  }
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

      if (forwardingUrl) {
        client.output.debug(`POST ${forwardingUrl}`);

        await fetch(forwardingUrl, {
          method: 'POST',
          headers: req.headers as Record<string, string>,
          body: JSON.stringify(body),
        });

        client.output.log(
          `Webhook ${chalk.bold(payload.type)} forwarded to ${forwardingUrl}`
        );
      }

      res.statusCode = 200;
    } catch (err) {
      client.output.error((err as Error).message);

      res.statusCode = 500;
    } finally {
      res.end();
    }
  }).listen(port);

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
      events: EVENTS,
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
