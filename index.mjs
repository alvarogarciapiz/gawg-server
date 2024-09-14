import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Webhooks } from '@octokit/webhooks';
import fs from 'fs';
import path from 'path';
import AWS from 'aws-sdk';

const dynamoDb = new AWS.DynamoDB.DocumentClient();

const checkRepositoryInDynamoDB = async (repositoryFullName) => {
  const params = {
    TableName: 'gawg',
    Key: {
      id: repositoryFullName,
    },
  };

  try {
    const result = await dynamoDb.get(params).promise();
    return result.Item ? result.Item : null;
  } catch (error) {
    console.error('Error checking DynamoDB:', error);
    throw new Error('Error checking DynamoDB');
  }
};

const readTemplate = (filePath) => {
  return fs.readFileSync(filePath, 'utf8');
};

const createRunnerTypeString = (config) => {
  if (config.runner.type === 'self-hosted') {
    let labels = config.runner.labels || [];
    if (!Array.isArray(labels)) {
      labels = [];
    }
    if (labels.length > 0) {
      return `[self-hosted, ${labels.join(', ')}]`;
    } else {
      return '[self-hosted]';
    }
  } else {
    return 'ubuntu-latest';
  }
};

const createDynamicConfig = (config) => {
  let dynamicConfig = '';

  if (config.technology === 'python') {
    dynamicConfig += `PYTHON_VERSION="3.10"\nPYTHON_DIST_DIR="./"\n`;
  } else if (config.technology === 'maven') {
    dynamicConfig += `JAVA_VERSION="8"\nJAVA_DIST_DIR="target/"\nJAVA_DISTRIBUTION="temurin"\n`;
  } else if (config.technology === 'node') {
    dynamicConfig += `NODE_VERSION="18"\nNODE_DIST_DIR="dist/"\n`;
  }

  return dynamicConfig;
};

const createTriggers = (triggers) => {
  let triggersStr = '';

  if (triggers.workflow_dispatch) {
    triggersStr += 'workflow_dispatch:\n';
  }

  if (triggers.push && triggers.push.active) {
    triggersStr += '  push:\n';
    if (triggers.push.branches) {
      triggersStr += '    branches:\n';
      triggers.push.branches.split(',').forEach(branch => {
        triggersStr += `      - ${branch.trim()}\n`;
      });
    }
  }

  if (triggers.schedule && triggers.schedule.active) {
    triggersStr += '  schedule:\n';
    triggersStr += `    - cron: '${triggers.schedule.cron}'\n`;
  }

  if (triggers.pull_request && triggers.pull_request.active) {
    triggersStr += '  pull_request:\n';
    if (triggers.pull_request.branches) {
      triggersStr += '    branches:\n';
      triggers.pull_request.branches.split(',').forEach(branch => {
        triggersStr += `      - ${branch.trim()}\n`;
      });
    }
  }

  return triggersStr;
};

const performSubstitutions = (template, config) => {
  return template
    .replaceAll('[[WORKFLOW_NAME]]', config.technology + ' Build and Deploy Workflow')
    .replaceAll('[[ON_TRIGGERS]]', createTriggers(config.triggers))
    .replaceAll('[[RUNS_ON_CONFIG]]', createRunnerTypeString(config))
    .replaceAll('[[TECHNOLOGY]]', config.technology)
    .replaceAll('[[MESSAGING_APP]]', "'" + config.notify + "'")
    .replaceAll('[[DOCKER_ENABLED]]', config.docker ? 'true' : 'false')
    .replaceAll('[[SELF_HOSTED_RUNNER_ENABLED]]', config.runner.type == 'self-hosted' ? 'true' : 'false')
    .replaceAll('[[DEPLOYMENT_TYPE]]', config.deploy)
    .replaceAll('[[DYNAMIC_CONFIG]]', createDynamicConfig(config));
};

const uninstallGitHubApp = async (installationId, appId, privateKey) => {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId,
      privateKey: privateKey,
    },
  });

  try {
    await octokit.apps.deleteInstallation({
      installation_id: installationId,
    });
    console.log(`Successfully uninstalled GitHub App with installation ID: ${installationId}`);
  } catch (error) {
    console.error(`Failed to uninstall GitHub App: ${error.message}`);
    throw new Error('Failed to uninstall GitHub App');
  }
};

export const handler = async (event) => {
  const APP_ID = process.env.GITHUB_APP_ID;
  const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
  const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

  console.log('APP_ID:', APP_ID);
  console.log('PRIVATE_KEY:', PRIVATE_KEY ? 'Loaded' : 'Not Loaded');
  console.log('WEBHOOK_SECRET:', WEBHOOK_SECRET);

  const webhooks = new Webhooks({
    secret: WEBHOOK_SECRET,
  });

  const signature = event.headers['X-Hub-Signature-256'];
  const payload = event.body;

  console.log('Signature:', signature);
  console.log('Payload:', payload);

  try {
    webhooks.verify(payload, signature);
  } catch (error) {
    console.error('Invalid signature:', error.message);
    return {
      statusCode: 401,
      body: JSON.stringify({ message: 'Invalid signature' }),
    };
  }

  let body;
  try {
    body = JSON.parse(payload);
  } catch (error) {
    console.error('Error parsing payload:', error.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid payload' }),
    };
  }

  const eventType = event.headers['X-GitHub-Event'];

  console.log('Event Type:', eventType);
  console.log('Body:', body);

  if (eventType === 'installation' && body.action === 'created') {
    const installationId = body.installation.id;
    const repositories = body.repositories;

    console.log(`Processing installation event for installationId: ${installationId}`);

    try {
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: APP_ID,
          privateKey: PRIVATE_KEY,
          installationId: installationId,
        },
      });

      const filesToCreate = [
        'workflow_config.yml',
        'sonar-project.properties',
        '.github/workflows/main.yml',
      ];

      for (const repo of repositories) {
        const owner = repo.full_name.split('/')[0];
        const repoName = repo.name;
        const repositoryFullName = repo.full_name;

        // Comprobar si el repositorio existe en DynamoDB
        const dbItem = await checkRepositoryInDynamoDB(repositoryFullName);

        for (const fileName of filesToCreate) {
          let content;
          if (dbItem) {
            // Si el repositorio existe en DynamoDB, obtener el contenido y hacer sustituciones
            const templatePath = path.join('./templates', path.basename(fileName));
            const template = readTemplate(templatePath);
            content = performSubstitutions(template, dbItem);
          } else {
            // Si el repositorio no existe en DynamoDB, leer el contenido del archivo
            const filePath = path.join('./templates', path.basename(fileName));
            content = fs.readFileSync(filePath, 'utf8');
          }

          if (fileName === 'workflow_config.yml') {
            content = content.replace('YOUR_PROJECT_NAME', repoName);
            content = content.replace('[[DYNAMIC_CONFIG]]', createDynamicConfig(dbItem || { technology: 'default' }));
          }

          const encodedContent = Buffer.from(content).toString('base64');
          const message = `Add ${path.basename(fileName)}`;

          console.log(`Creating file ${fileName} in repo: ${owner}/${repoName}`);

          let sha;
          try {
            const { data: existingFile } = await octokit.repos.getContent({
              owner,
              repo: repoName,
              path: fileName,
            });
            sha = existingFile.sha;
            console.log(`File ${fileName} already exists in repo: ${owner}/${repoName}, skipping creation.`);
            continue; // Skip file creation if it already exists
          } catch (error) {
            if (error.status !== 404) {
              throw error;
            }
          }

          const params = {
            owner,
            repo: repoName,
            path: fileName,
            message,
            content: encodedContent,
          };

          if (sha) {
            params.sha = sha;
          }

          await octokit.repos.createOrUpdateFileContents(params);

          console.log(`File ${fileName} created in repo: ${owner}/${repoName}`);
        }
      }

      // Uninstall the GitHub App after all files are added
      await uninstallGitHubApp(installationId, APP_ID, PRIVATE_KEY);

    } catch (error) {
      console.error(`Error processing installation event: ${error.message}`);
      console.error(error);
      return {
        statusCode: 500,
        body: JSON.stringify({ message: 'Internal Server Error' }),
      };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Event processed successfully' }),
  };
};