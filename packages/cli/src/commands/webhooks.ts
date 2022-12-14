import chalk from 'chalk';
import getArgs from '../util/get-args';
import logo from '../util/output/logo';
import { handleError } from '../util/error';
import { getPkgName } from '../util/pkg-name';
import Client from '../util/client';
import { ALL_EVENTS, WebhookServer } from '../util/webhooks';

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
    const webhookServer = new WebhookServer(client, {
      logWebhookPayloads,
      forwardingRules: forwardingUrl
        ? [
            {
              url: forwardingUrl,
              events: ALL_EVENTS,
            },
          ]
        : [],
    });

    try {
      await webhookServer.start();

      const exitGracefully = async () => {
        try {
          await webhookServer.stop();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      process.once('SIGTERM', exitGracefully);
      process.once('SIGINT', exitGracefully);
      process.once('SIGUSR1', exitGracefully);
      process.once('SIGUSR2', exitGracefully);
    } catch (err) {
      await webhookServer
        .stop()
        .then(() => reject(err))
        .catch(reject);
    }
  });
}
