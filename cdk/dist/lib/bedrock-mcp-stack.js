"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BedrockMcpStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const iam = require("aws-cdk-lib/aws-iam");
const elbv2 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
class BedrockMcpStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const prefix = props?.namePrefix || 'MCP';
        // Create VPC
        const vpc = new ec2.Vpc(this, `${prefix}-VPC`, {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                }
            ]
        });
        // Create Security Group
        const sg = new ec2.SecurityGroup(this, `${prefix}-SG`, {
            vpc,
            allowAllOutbound: true,
            description: 'Security group for MCP services'
        });
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8502), 'Streamlit UI');
        // Create IAM Role
        const role = new iam.Role(this, 'EC2-Role', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
            ]
        });
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel*',
                'bedrock:ListFoundationModels'
            ],
            resources: ['*']
        }));
        // Create Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, `${prefix}-ALB`, {
            vpc,
            internetFacing: true
        });
        // Create ALB Listeners
        const streamlitListener = alb.addListener('Streamlit', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP
        });
        // Create IAM User for API Access with dynamic name
        const apiUser = new iam.User(this, 'BedrockApiUser', {
            userName: `bedrock-mcp-api-user-${cdk.Stack.of(this).stackName}`
        });
        apiUser.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel*',
                'bedrock:ListFoundationModels'
            ],
            resources: ['*']
        }));
        // Create access key for the user
        const accessKey = new iam.CfnAccessKey(this, 'BedrockApiAccessKey', {
            userName: apiUser.userName
        });
        // Create User Data with improved initialization
        const userData = ec2.UserData.forLinux();
        userData.addCommands('#!/bin/bash', 
        // Set HOME and PATH environment variables first
        'export HOME=/root', 'export PATH="/usr/local/bin:$PATH"', 
        // Update and install dependencies
        'apt-get update', 'apt-get install -y software-properties-common', 'add-apt-repository -y ppa:deadsnakes/ppa', 'apt-get update', 'apt-get install -y python3.12 python3.12-venv git', 
        // Install Node.js
        'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -', 'apt-get install -y nodejs', 
        // Install UV for ubuntu user
        'su - ubuntu -c "curl -LsSf https://astral.sh/uv/install.sh | sh"', 'echo \'export PATH="/home/ubuntu/.local/bin:$PATH"\' >> /home/ubuntu/.bashrc', 
        // Create and set up project directory with proper ownership
        'mkdir -p /home/ubuntu/demo_mcp_on_amazon_bedrock', 'chown ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock', 'cd /home/ubuntu/demo_mcp_on_amazon_bedrock', 
        // Clone project with HTTPS and retry logic
        'MAX_RETRIES=3', 'RETRY_COUNT=0', 'while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do', '    git clone https://github.com/aws-samples/demo_mcp_on_amazon_bedrock.git . && break', '    RETRY_COUNT=$((RETRY_COUNT+1))', '    if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then', '        echo "Git clone attempt $RETRY_COUNT failed, retrying in 5 seconds..."', '        sleep 5', '    fi', 'done', 
        // Exit if git clone ultimately failed
        '[ -z "$(ls -A /home/ubuntu/demo_mcp_on_amazon_bedrock)" ] && echo "Failed to clone repository" && exit 1', 
        // Create necessary directories with proper ownership
        'mkdir -p logs tmp', 'chown -R ubuntu:ubuntu /home/ubuntu/demo_mcp_on_amazon_bedrock', 'chmod 755 /home/ubuntu/demo_mcp_on_amazon_bedrock', 'chmod 755 logs tmp', 
        // Setup Python environment as ubuntu user
        'su - ubuntu -c "cd /home/ubuntu/demo_mcp_on_amazon_bedrock && \
        python3.12 -m venv .venv && \
        source .venv/bin/activate && \
        source /home/ubuntu/.bashrc && \
        uv pip install ."', 
        // Configure environment with proper ownership
        'cat > .env << EOL', `AWS_ACCESS_KEY_ID=${accessKey.ref}`, `AWS_SECRET_ACCESS_KEY=${accessKey.attrSecretAccessKey}`, 'AWS_REGION=' + cdk.Stack.of(this).region, 'LOG_DIR=./logs', 'CHATBOT_SERVICE_PORT=8502', 'MCP_SERVICE_HOST=127.0.0.1', 'MCP_SERVICE_PORT=7002', `API_KEY=${cdk.Names.uniqueId(this)}`, 'EOL', 'chown ubuntu:ubuntu .env', 'chmod 600 .env', // Secure permissions for credentials file
        // Setup systemd service
        'cat > /etc/systemd/system/mcp-services.service << EOL', '[Unit]', 'Description=MCP Services', 'After=network.target', '', '[Service]', 'Type=forking', 'User=ubuntu', 'Environment="HOME=/home/ubuntu"', 'Environment="PATH=/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"', 'WorkingDirectory=/home/ubuntu/demo_mcp_on_amazon_bedrock', 'ExecStart=/bin/bash start_all.sh', 'ExecStop=/bin/bash stop_all.sh', 'Restart=always', '', '[Install]', 'WantedBy=multi-user.target', 'EOL', 
        // Enable and start service
        'systemctl daemon-reload', 'systemctl enable mcp-services', 'systemctl start mcp-services');
        // Create Auto Scaling Group
        const asg = new autoscaling.AutoScalingGroup(this, `${prefix}-ASG`, {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id', { os: ec2.OperatingSystemType.LINUX }),
            blockDevices: [
                {
                    deviceName: '/dev/sda1', // Root volume
                    volume: autoscaling.BlockDeviceVolume.ebs(100), // 100 GB
                }
            ],
            userData,
            role,
            securityGroup: sg,
            minCapacity: 1,
            maxCapacity: 1,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
            }
        });
        // Add ASG as target for ALB listeners
        streamlitListener.addTargets('Streamlit-Target', {
            port: 8502,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [asg],
            healthCheck: {
                path: '/',
                unhealthyThresholdCount: 2,
                healthyThresholdCount: 5,
                interval: cdk.Duration.seconds(30)
            }
        });
        // Stack Outputs
        new cdk.CfnOutput(this, 'Streamlit-Endpoint', {
            value: `http://${alb.loadBalancerDnsName}:8502`,
            description: 'Streamlit UI Endpoint'
        });
        // Output the API credentials
        new cdk.CfnOutput(this, 'ApiAccessKeyId', {
            value: accessKey.ref,
            description: 'API Access Key ID'
        });
        new cdk.CfnOutput(this, 'ApiSecretAccessKey', {
            value: accessKey.attrSecretAccessKey,
            description: 'API Secret Access Key'
        });
    }
}
exports.BedrockMcpStack = BedrockMcpStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmVkcm9jay1tY3Atc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYmVkcm9jay1tY3Atc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQywyQ0FBMkM7QUFDM0MsZ0VBQWdFO0FBQ2hFLDJEQUEyRDtBQU8zRCxNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLE1BQU0sR0FBRyxLQUFLLEVBQUUsVUFBVSxJQUFJLEtBQUssQ0FBQztRQUUxQyxhQUFhO1FBQ2IsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0sTUFBTSxFQUFFO1lBQzdDLE1BQU0sRUFBRSxDQUFDO1lBQ1QsV0FBVyxFQUFFLENBQUM7WUFDZCxtQkFBbUIsRUFBRTtnQkFDbkI7b0JBQ0UsSUFBSSxFQUFFLFFBQVE7b0JBQ2QsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsTUFBTTtvQkFDakMsUUFBUSxFQUFFLEVBQUU7aUJBQ2I7Z0JBQ0Q7b0JBQ0UsSUFBSSxFQUFFLFNBQVM7b0JBQ2YsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CO29CQUM5QyxRQUFRLEVBQUUsRUFBRTtpQkFDYjthQUNGO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLE1BQU0sRUFBRSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsR0FBRyxNQUFNLEtBQUssRUFBRTtZQUNyRCxHQUFHO1lBQ0gsZ0JBQWdCLEVBQUUsSUFBSTtZQUN0QixXQUFXLEVBQUUsaUNBQWlDO1NBQy9DLENBQUMsQ0FBQztRQUVILEVBQUUs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LENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxTQUFTLENBQUMsR0FBRztZQUNwQixXQUFXLEVBQUUsbUJBQW1CO1NBQ2pDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsb0JBQW9CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLFNBQVMsQ0FBQyxtQkFBbUI7WUFDcEMsV0FBVyxFQUFFLHVCQUF1QjtTQUNyQyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEvT0QsMENBK09DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjMiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWMyJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIGVsYnYyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCAqIGFzIGF1dG9zY2FsaW5nIGZyb20gJ2F3cy1jZGstbGliL2F3cy1hdXRvc2NhbGluZyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBCZWRyb2NrTWNwU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgbmFtZVByZWZpeD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEJlZHJvY2tNY3BTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogQmVkcm9ja01jcFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHByZWZpeCA9IHByb3BzPy5uYW1lUHJlZml4IHx8ICdNQ1AnO1xuXG4gICAgLy8gQ3JlYXRlIFZQQ1xuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsIGAke3ByZWZpeH0tVlBDYCwge1xuICAgICAgbWF4QXpzOiAyLFxuICAgICAgbmF0R2F0ZXdheXM6IDEsXG4gICAgICBzdWJuZXRDb25maWd1cmF0aW9uOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnUHVibGljJyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QVUJMSUMsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICB9XG4gICAgICBdXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgU2VjdXJpdHkgR3JvdXBcbiAgICBjb25zdCBzZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCBgJHtwcmVmaXh9LVNHYCwge1xuICAgICAgdnBjLFxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2VjdXJpdHkgZ3JvdXAgZm9yIE1DUCBzZXJ2aWNlcydcbiAgICB9KTtcblxuICAgIHNnLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuYW55SXB2NCgpLFxuICAgICAgZWMyLlBvcnQudGNwKDg1MDIpLFxuICAgICAgJ1N0cmVhbWxpdCBVSSdcbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIElBTSBSb2xlXG4gICAgY29uc3Qgcm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRUMyLVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWMyLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0FtYXpvblNTTU1hbmFnZWRJbnN0YW5jZUNvcmUnKVxuICAgICAgXVxuICAgIH0pO1xuXG4gICAgcm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsKicsXG4gICAgICAgICdiZWRyb2NrOkxpc3RGb3VuZGF0aW9uTW9kZWxzJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ11cbiAgICB9KSk7XG5cbiAgICAvLyBDcmVhdGUgQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxuICAgIGNvbnN0IGFsYiA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCBgJHtwcmVmaXh9LUFMQmAsIHtcbiAgICAgIHZwYyxcbiAgICAgIGludGVybmV0RmFjaW5nOiB0cnVlXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgQUxCIExpc3RlbmVyc1xuICAgIGNvbnN0IHN0cmVhbWxpdExpc3RlbmVyID0gYWxiLmFkZExpc3RlbmVyKCdTdHJlYW1saXQnLCB7IFxuICAgICAgcG9ydDogODUwMixcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFBcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBJQU0gVXNlciBmb3IgQVBJIEFjY2VzcyB3aXRoIGR5bmFtaWMgbmFtZVxuICAgIGNvbnN0IGFwaVVzZXIgPSBuZXcgaWFtLlVzZXIodGhpcywgJ0JlZHJvY2tBcGlVc2VyJywge1xuICAgICAgdXNlck5hbWU6IGBiZWRyb2NrLW1jcC1hcGktdXNlci0ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9YFxuICAgIH0pO1xuXG4gICAgYXBpVXNlci5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsKicsXG4gICAgICAgICdiZWRyb2NrOkxpc3RGb3VuZGF0aW9uTW9kZWxzJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ11cbiAgICB9KSk7XG5cbiAgICAvLyBDcmVhdGUgYWNjZXNzIGtleSBmb3IgdGhlIHVzZXJcbiAgICBjb25zdCBhY2Nlc3NLZXkgPSBuZXcgaWFtLkNmbkFjY2Vzc0tleSh0aGlzLCAnQmVkcm9ja0FwaUFjY2Vzc0tleScsIHtcbiAgICAgIHVzZXJOYW1lOiBhcGlVc2VyLnVzZXJOYW1lXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgVXNlciBEYXRhIHdpdGggaW1wcm92ZWQgaW5pdGlhbGl6YXRpb25cbiAgICBjb25zdCB1c2VyRGF0YSA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xuICAgIHVzZXJEYXRhLmFkZENvbW1hbmRzKFxuICAgICAgJyMhL2Jpbi9iYXNoJyxcbiAgICAgIFxuICAgICAgLy8gU2V0IEhPTUUgYW5kIFBBVEggZW52aXJvbm1lbnQgdmFyaWFibGVzIGZpcnN0XG4gICAgICAnZXhwb3J0IEhPTUU9L3Jvb3QnLFxuICAgICAgJ2V4cG9ydCBQQVRIPVwiL3Vzci9sb2NhbC9iaW46JFBBVEhcIicsXG4gICAgICBcbiAgICAgIC8vIFVwZGF0ZSBhbmQgaW5zdGFsbCBkZXBlbmRlbmNpZXNcbiAgICAgICdhcHQtZ2V0IHVwZGF0ZScsXG4gICAgICAnYXB0LWdldCBpbnN0YWxsIC15IHNvZnR3YXJlLXByb3BlcnRpZXMtY29tbW9uJyxcbiAgICAgICdhZGQtYXB0LXJlcG9zaXRvcnkgLXkgcHBhOmRlYWRzbmFrZXMvcHBhJyxcbiAgICAgICdhcHQtZ2V0IHVwZGF0ZScsXG4gICAgICAnYXB0LWdldCBpbnN0YWxsIC15IHB5dGhvbjMuMTIgcHl0aG9uMy4xMi12ZW52IGdpdCcsXG4gICAgICBcbiAgICAgIFxuICAgICAgLy8gSW5zdGFsbCBOb2RlLmpzXG4gICAgICAnY3VybCAtZnNTTCBodHRwczovL2RlYi5ub2Rlc291cmNlLmNvbS9zZXR1cF8yMi54IHwgYmFzaCAtJyxcbiAgICAgICdhcHQtZ2V0IGluc3RhbGwgLXkgbm9kZWpzJyxcbiAgICAgIFxuICAgICAgLy8gSW5zdGFsbCBVViBmb3IgdWJ1bnR1IHVzZXJcbiAgICAgICdzdSAtIHVidW50dSAtYyBcImN1cmwgLUxzU2YgaHR0cHM6Ly9hc3RyYWwuc2gvdXYvaW5zdGFsbC5zaCB8IHNoXCInLFxuICAgICAgJ2VjaG8gXFwnZXhwb3J0IFBBVEg9XCIvaG9tZS91YnVudHUvLmxvY2FsL2JpbjokUEFUSFwiXFwnID4+IC9ob21lL3VidW50dS8uYmFzaHJjJyxcbiAgICAgIFxuICAgICAgLy8gQ3JlYXRlIGFuZCBzZXQgdXAgcHJvamVjdCBkaXJlY3Rvcnkgd2l0aCBwcm9wZXIgb3duZXJzaGlwXG4gICAgICAnbWtkaXIgLXAgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdjaG93biB1YnVudHU6dWJ1bnR1IC9ob21lL3VidW50dS9kZW1vX21jcF9vbl9hbWF6b25fYmVkcm9jaycsXG4gICAgICAnY2QgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgIFxuICAgICAgLy8gQ2xvbmUgcHJvamVjdCB3aXRoIEhUVFBTIGFuZCByZXRyeSBsb2dpY1xuICAgICAgJ01BWF9SRVRSSUVTPTMnLFxuICAgICAgJ1JFVFJZX0NPVU5UPTAnLFxuICAgICAgJ3doaWxlIFsgJFJFVFJZX0NPVU5UIC1sdCAkTUFYX1JFVFJJRVMgXTsgZG8nLFxuICAgICAgJyAgICBnaXQgY2xvbmUgaHR0cHM6Ly9naXRodWIuY29tL2F3cy1zYW1wbGVzL2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrLmdpdCAuICYmIGJyZWFrJyxcbiAgICAgICcgICAgUkVUUllfQ09VTlQ9JCgoUkVUUllfQ09VTlQrMSkpJyxcbiAgICAgICcgICAgaWYgWyAkUkVUUllfQ09VTlQgLWx0ICRNQVhfUkVUUklFUyBdOyB0aGVuJyxcbiAgICAgICcgICAgICAgIGVjaG8gXCJHaXQgY2xvbmUgYXR0ZW1wdCAkUkVUUllfQ09VTlQgZmFpbGVkLCByZXRyeWluZyBpbiA1IHNlY29uZHMuLi5cIicsXG4gICAgICAnICAgICAgICBzbGVlcCA1JyxcbiAgICAgICcgICAgZmknLFxuICAgICAgJ2RvbmUnLFxuICAgICAgXG4gICAgICAvLyBFeGl0IGlmIGdpdCBjbG9uZSB1bHRpbWF0ZWx5IGZhaWxlZFxuICAgICAgJ1sgLXogXCIkKGxzIC1BIC9ob21lL3VidW50dS9kZW1vX21jcF9vbl9hbWF6b25fYmVkcm9jaylcIiBdICYmIGVjaG8gXCJGYWlsZWQgdG8gY2xvbmUgcmVwb3NpdG9yeVwiICYmIGV4aXQgMScsXG4gICAgICBcbiAgICAgIC8vIENyZWF0ZSBuZWNlc3NhcnkgZGlyZWN0b3JpZXMgd2l0aCBwcm9wZXIgb3duZXJzaGlwXG4gICAgICAnbWtkaXIgLXAgbG9ncyB0bXAnLFxuICAgICAgJ2Nob3duIC1SIHVidW50dTp1YnVudHUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdjaG1vZCA3NTUgL2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdjaG1vZCA3NTUgbG9ncyB0bXAnLFxuXG4gICAgICAvLyBTZXR1cCBQeXRob24gZW52aXJvbm1lbnQgYXMgdWJ1bnR1IHVzZXJcbiAgICAgICdzdSAtIHVidW50dSAtYyBcImNkIC9ob21lL3VidW50dS9kZW1vX21jcF9vbl9hbWF6b25fYmVkcm9jayAmJiBcXFxuICAgICAgICBweXRob24zLjEyIC1tIHZlbnYgLnZlbnYgJiYgXFxcbiAgICAgICAgc291cmNlIC52ZW52L2Jpbi9hY3RpdmF0ZSAmJiBcXFxuICAgICAgICBzb3VyY2UgL2hvbWUvdWJ1bnR1Ly5iYXNocmMgJiYgXFxcbiAgICAgICAgdXYgcGlwIGluc3RhbGwgLlwiJyxcblxuICAgICAgLy8gQ29uZmlndXJlIGVudmlyb25tZW50IHdpdGggcHJvcGVyIG93bmVyc2hpcFxuICAgICAgJ2NhdCA+IC5lbnYgPDwgRU9MJyxcbiAgICAgIGBBV1NfQUNDRVNTX0tFWV9JRD0ke2FjY2Vzc0tleS5yZWZ9YCxcbiAgICAgIGBBV1NfU0VDUkVUX0FDQ0VTU19LRVk9JHthY2Nlc3NLZXkuYXR0clNlY3JldEFjY2Vzc0tleX1gLFxuICAgICAgJ0FXU19SRUdJT049JyArIGNkay5TdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAnTE9HX0RJUj0uL2xvZ3MnLFxuICAgICAgJ0NIQVRCT1RfU0VSVklDRV9QT1JUPTg1MDInLFxuICAgICAgJ01DUF9TRVJWSUNFX0hPU1Q9MTI3LjAuMC4xJyxcbiAgICAgICdNQ1BfU0VSVklDRV9QT1JUPTcwMDInLFxuICAgICAgYEFQSV9LRVk9JHtjZGsuTmFtZXMudW5pcXVlSWQodGhpcyl9YCxcbiAgICAgICdFT0wnLFxuICAgICAgJ2Nob3duIHVidW50dTp1YnVudHUgLmVudicsXG4gICAgICAnY2htb2QgNjAwIC5lbnYnLCAgLy8gU2VjdXJlIHBlcm1pc3Npb25zIGZvciBjcmVkZW50aWFscyBmaWxlXG4gICAgICBcblxuICAgICAgXG4gICAgICAvLyBTZXR1cCBzeXN0ZW1kIHNlcnZpY2VcbiAgICAgICdjYXQgPiAvZXRjL3N5c3RlbWQvc3lzdGVtL21jcC1zZXJ2aWNlcy5zZXJ2aWNlIDw8IEVPTCcsXG4gICAgICAnW1VuaXRdJyxcbiAgICAgICdEZXNjcmlwdGlvbj1NQ1AgU2VydmljZXMnLFxuICAgICAgJ0FmdGVyPW5ldHdvcmsudGFyZ2V0JyxcbiAgICAgICcnLFxuICAgICAgJ1tTZXJ2aWNlXScsXG4gICAgICAnVHlwZT1mb3JraW5nJyxcbiAgICAgICdVc2VyPXVidW50dScsXG4gICAgICAnRW52aXJvbm1lbnQ9XCJIT01FPS9ob21lL3VidW50dVwiJyxcbiAgICAgICdFbnZpcm9ubWVudD1cIlBBVEg9L2hvbWUvdWJ1bnR1Ly5sb2NhbC9iaW46L3Vzci9sb2NhbC9zYmluOi91c3IvbG9jYWwvYmluOi91c3Ivc2JpbjovdXNyL2Jpbjovc2JpbjovYmluXCInLFxuICAgICAgJ1dvcmtpbmdEaXJlY3Rvcnk9L2hvbWUvdWJ1bnR1L2RlbW9fbWNwX29uX2FtYXpvbl9iZWRyb2NrJyxcbiAgICAgICdFeGVjU3RhcnQ9L2Jpbi9iYXNoIHN0YXJ0X2FsbC5zaCcsXG4gICAgICAnRXhlY1N0b3A9L2Jpbi9iYXNoIHN0b3BfYWxsLnNoJyxcbiAgICAgICdSZXN0YXJ0PWFsd2F5cycsXG4gICAgICAnJyxcbiAgICAgICdbSW5zdGFsbF0nLFxuICAgICAgJ1dhbnRlZEJ5PW11bHRpLXVzZXIudGFyZ2V0JyxcbiAgICAgICdFT0wnLFxuICAgICAgXG4gICAgICAvLyBFbmFibGUgYW5kIHN0YXJ0IHNlcnZpY2VcbiAgICAgICdzeXN0ZW1jdGwgZGFlbW9uLXJlbG9hZCcsXG4gICAgICAnc3lzdGVtY3RsIGVuYWJsZSBtY3Atc2VydmljZXMnLFxuICAgICAgJ3N5c3RlbWN0bCBzdGFydCBtY3Atc2VydmljZXMnXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBBdXRvIFNjYWxpbmcgR3JvdXBcbiAgICBjb25zdCBhc2cgPSBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCBgJHtwcmVmaXh9LUFTR2AsIHtcbiAgICAgIHZwYyxcbiAgICAgIGluc3RhbmNlVHlwZTogZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5UMywgZWMyLkluc3RhbmNlU2l6ZS5NRURJVU0pLFxuICAgICAgbWFjaGluZUltYWdlOiBlYzIuTWFjaGluZUltYWdlLmZyb21Tc21QYXJhbWV0ZXIoXG4gICAgICAgICcvYXdzL3NlcnZpY2UvY2Fub25pY2FsL3VidW50dS9zZXJ2ZXIvMjIuMDQvc3RhYmxlL2N1cnJlbnQvYW1kNjQvaHZtL2Vicy1ncDIvYW1pLWlkJyxcbiAgICAgICAgeyBvczogZWMyLk9wZXJhdGluZ1N5c3RlbVR5cGUuTElOVVggfVxuICAgICAgKSxcbiAgICAgIGJsb2NrRGV2aWNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgZGV2aWNlTmFtZTogJy9kZXYvc2RhMScsICAvLyBSb290IHZvbHVtZVxuICAgICAgICAgIHZvbHVtZTogYXV0b3NjYWxpbmcuQmxvY2tEZXZpY2VWb2x1bWUuZWJzKDEwMCksIC8vIDEwMCBHQlxuICAgICAgICB9XG4gICAgICBdLFxuICAgICAgdXNlckRhdGEsXG4gICAgICByb2xlLFxuICAgICAgc2VjdXJpdHlHcm91cDogc2csXG4gICAgICBtaW5DYXBhY2l0eTogMSxcbiAgICAgIG1heENhcGFjaXR5OiAxLFxuICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQVNHIGFzIHRhcmdldCBmb3IgQUxCIGxpc3RlbmVyc1xuICAgIHN0cmVhbWxpdExpc3RlbmVyLmFkZFRhcmdldHMoJ1N0cmVhbWxpdC1UYXJnZXQnLCB7XG4gICAgICBwb3J0OiA4NTAyLFxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcbiAgICAgIHRhcmdldHM6IFthc2ddLFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgcGF0aDogJy8nLFxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiA1LFxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBTdGFjayBPdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1N0cmVhbWxpdC1FbmRwb2ludCcsIHtcbiAgICAgIHZhbHVlOiBgaHR0cDovLyR7YWxiLmxvYWRCYWxhbmNlckRuc05hbWV9Ojg1MDJgLFxuICAgICAgZGVzY3JpcHRpb246ICdTdHJlYW1saXQgVUkgRW5kcG9pbnQnXG4gICAgfSk7XG5cbiAgICAvLyBPdXRwdXQgdGhlIEFQSSBjcmVkZW50aWFsc1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlBY2Nlc3NLZXlJZCcsIHtcbiAgICAgIHZhbHVlOiBhY2Nlc3NLZXkucmVmLFxuICAgICAgZGVzY3JpcHRpb246ICdBUEkgQWNjZXNzIEtleSBJRCdcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlTZWNyZXRBY2Nlc3NLZXknLCB7XG4gICAgICB2YWx1ZTogYWNjZXNzS2V5LmF0dHJTZWNyZXRBY2Nlc3NLZXksXG4gICAgICBkZXNjcmlwdGlvbjogJ0FQSSBTZWNyZXQgQWNjZXNzIEtleSdcbiAgICB9KTtcbiAgfVxufVxuIl19