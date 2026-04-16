import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'
import config from './config.js'

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
    installationId: config.GITHUB_INSTALLATION_ID,
  },
})

export default octokit
