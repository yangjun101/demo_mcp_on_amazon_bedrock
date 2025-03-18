#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BedrockMcpStack } from '../lib/bedrock-mcp-stack';

const app = new cdk.App();

// Get qualifier from context or CDK_QUALIFIER env var (set by --qualifier)
const qualifier = app.node.tryGetContext('qualifier') || process.env.CDK_QUALIFIER;

// Require either --context qualifier or --qualifier
if (!qualifier) {
  throw new Error("Qualifier must be provided via --context qualifier=<value> or --qualifier=<value>");
}

// Environment configuration
const env = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
};

// Stack configuration
const stackProps = {
  env,
  description: 'Bedrock MCP Demo Stack',
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: qualifier,
    bootstrapStackVersionSsmParameter: `/cdk-bootstrap/${qualifier}/version`,
    fileAssetsBucketName: `cdk-${qualifier}-assets-${env.account}-${env.region}`
  })
};

// Create stack with qualifier
new BedrockMcpStack(app, `BedrockMcpStack-${qualifier}`, stackProps);
