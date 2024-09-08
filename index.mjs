import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export const handler = async (event) => {
  const APP_ID = process.env.GITHUB_APP_ID;
  const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
  const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

  const body = JSON.parse(event.body);
  const eventType = event.headers['X-GitHub-Event'];

  if (eventType === 'repository') {
    const repoName = body.repository.name;
    const owner = body.repository.owner.login;

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: APP_ID,
        privateKey: PRIVATE_KEY,
        installationId: body.installation.id,
      },
    });

    // Commit files to the repository
    await commitFiles(octokit, owner, repoName);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Webhook received' }),
  };
};

async function commitFiles(octokit, owner, repo) {
  const files = {
    '.github/workflows/deploy.yml': `
name: Deploy

on: [push]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v2

    - name: Set up Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '14'

    - name: Install dependencies
      run: npm install

    - name: Run tests
      run: npm test

    - name: Deploy to S3
      env:
        AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
        AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
      run: |
        aws s3 cp ./ s3://my-bucket --recursive
    `,
    'sonar-project.properties': `
# Required metadata
sonar.projectKey=my_project_key
sonar.organization=my_organization

# Comma-separated paths to directories with sources (required)
sonar.sources=src

# Encoding of the source files
sonar.sourceEncoding=UTF-8
    `,
    'README.md': `
# GitHub Actions Workflow Setup

This repository contains the necessary files to set up a GitHub Actions workflow for deploying your project.

## Setup Guide

1. **Copy the Files**:
   - Copy the \`.github/workflows/deploy.yml\` file to the root of your repository.
   - Copy the \`sonar-project.properties\` file to the root of your repository.
   - Copy this \`README.md\` file to the root of your repository.

2. **Add Secrets**:
   - Go to your repository settings.
   - Add the following secrets:
     - \`AWS_KEY_ID\`
     - \`AWS_SECRET_ACCESS_KEY\`

3. **Commit the Files**:
   - Commit the three files to your repository.

4. **Push the Changes**:
   - Push the changes to your GitHub repository.

Your workflow is now set up and will run on every push to the repository.
    `,
  };

  for (const [path, content] of Object.entries(files)) {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `Add ${path}`,
      content: Buffer.from(content).toString('base64'),
    });
  }
}