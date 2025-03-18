# Bedrock MCP CDK

This CDK project deploys the Bedrock MCP Demo application to AWS.

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js v22.x
- AWS CDK CLI installed (`npm install -g aws-cdk`)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Bootstrap and Deploy:
```bash
# Generate timestamp for unique qualifier
cd /home/ubuntu/demo_mcp_on_amazon_bedrock/cdk && \
TIMESTAMP=$(date +%H%M%S) && \
cdk bootstrap --context qualifier=cdk$TIMESTAMP --qualifier cdk$TIMESTAMP --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP && \
cdk deploy --context qualifier=cdk$TIMESTAMP --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP
```

IMPORTANT: 
- The qualifier must be provided via --qualifier and --context during bootstrap
- The same qualifier must be used in --context during deploy
- Each deployment should use a unique qualifier (e.g. using timestamp)
- The toolkit stack name must match between bootstrap and deploy commands

To deploy multiple instances:
```bash
# First instance with timestamp1
TIMESTAMP1=$(date +%H%M%S)
cdk bootstrap --context qualifier=cdk$TIMESTAMP1 --qualifier cdk$TIMESTAMP1 --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP1 && \
cdk deploy --context qualifier=cdk$TIMESTAMP1 --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP1

# Second instance with timestamp2
TIMESTAMP2=$(date +%H%M%S)
cdk bootstrap --context qualifier=cdk$TIMESTAMP2 --qualifier cdk$TIMESTAMP2 --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP2 && \
cdk deploy --context qualifier=cdk$TIMESTAMP2 --toolkit-stack-name CDKToolkit-cdk$TIMESTAMP2
```

## Stack Components

- VPC with public and private subnets
- EC2 instance running in private subnet
- Application Load Balancer in public subnet
- Security groups for EC2 and ALB
- IAM role with Bedrock permissions
- Auto Scaling Group (min=1, max=1)

## Services

The stack deploys two services:
- FastAPI Chat Service (port 7002)
- Streamlit UI (port 8502)

## Environment Variables

The EC2 instance will be configured with:
```
AWS_REGION=us-east-1
LOG_DIR=./logs
CHATBOT_SERVICE_PORT=8502
MCP_SERVICE_HOST=127.0.0.1
MCP_SERVICE_PORT=7002
```

## Useful Commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template
