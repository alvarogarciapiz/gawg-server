import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { Webhooks } from '@octokit/webhooks';
import fs from 'fs';
import path from 'path';

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

        for (const fileName of filesToCreate) {
          const filePath = path.join('./templates', path.basename(fileName));
          const content = fs.readFileSync(filePath, 'utf8');
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